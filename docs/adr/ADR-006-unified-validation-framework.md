<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-006: Unified Validation Framework

## Status

Accepted — in progress (Wave 5)

## Context

The codebase carries **three parallel validation subsystems**, each with its own
engine, its own base/contract, and its own result shape. They grew independently
and do not know about each other.

### Subsystem A — accelerator compatibility

- `src/lib/validation-engine.js` (`ValidationEngine`) auto-registers four
  accelerator validators (cuda, neuron, cpu, rocm) via
  `registerAcceleratorValidator`, and exposes
  `validateAcceleratorCompatibility(frameworkConfig, instanceConfig)` plus
  `validateEnvironmentVariables(...)`.
- `src/lib/accelerator-validator.js` (`AcceleratorValidator`) is the abstract
  base: `validate(frameworkConfig, instanceConfig)` and
  `getVersionMismatchMessage(required, provided)`.
- `{cuda,neuron,cpu,rocm}-validator.js` are the strategies.
- **Result shape:** `{ compatible: boolean, error?, warning?, info? }` (strings).
  `validateEnvironmentVariables` returns `{ errors[], warnings[], strategiesUsed[] }`.
- **Instantiated only** in `src/lib/registry-config-manager.js`; env-var
  validation is triggered from `src/lib/template-variable-resolver.js` via
  `_validateEnvironmentVariables(answers, registryConfigManager)`.
- The `neuron` and `rocm` strategies' `parseVersion` / `isCompatible` logic is
  **byte-identical** (major must match, minor must be `>=`); `cuda` inlines the
  same logic; `cpu` always returns `{ compatible: true }`.

### Subsystem B — schema/finding pipeline

- `src/lib/schema-validation-engine.js` (`SchemaValidationEngine`) runs a
  static → cross-cutting → smart pipeline over a `ValidationContext`, with
  `registerValidator` and `checkStaleness`. Auto-registers `EnumValidator`,
  `TypeValidator`, `RequiredFieldValidator` (not `CatalogValidator`).
- `src/lib/validators/base-validator.js` (`BaseValidator`) is the contract:
  `name`, `mode` (`'static' | 'smart' | 'both'`), and
  `async validate(context, { priorFindings, serviceModels })` returning an
  `Array<Finding>`.
- **Result shape:** an `Array<Finding>`, where a Finding is
  `{ service, operation, fieldPath, invalidValue, constraint, severity,
  confidence, source, remediationHint }`, routed by
  `src/lib/validation-report.js` (`ValidationReport`) into
  `schemaErrors / crossCuttingErrors / advisoryFindings / warnings`.
- Driven by `do/validate` (`validate-runner.js`), `dry-run-validator.js`
  (`{ passed, report, skipped }`), and `generation-validator.js`
  (`{ skipped, report }`).

### Subsystem C — CLI config + ad-hoc checks

- `src/lib/config-validator.js` (`ConfigValidator`) — `validateConfiguration()`
  and `validateRequiredParameters()`, each returning an `Array<string>` of
  human-readable messages.
- `parameter-schema-validator.js` → `{ valid, error? }`.
- `tune-catalog-validator.js` → `validateModel/Technique/TrainingType` →
  `{ valid, error? }`.
- `e2e-catalog-validator.js` → `validateCatalog` → `{ valid, errors: [{ path, message }] }`.
- `e2e-quota-validator.js` → `validateQuotas` →
  `Array<{ instanceType, required, available, sufficient }>`.

### Why this is a problem

For an AI maintainer, "three engines, two base classes, five result shapes" is
the worst case: to reason about *whether a config is valid*, you must know which
of three unrelated pipelines answers that question, and each answers it in a
different vocabulary. There is no single "run validation" entrypoint, no single
"what is a finding" definition, and the near-identical neuron/rocm strategies
invite drift.

## Decision

Establish **one validator contract, one finding shape, and one engine**, and
express every existing check in those terms. `SchemaValidationEngine` (Subsystem
B) is the most general of the three — it already has a plugin registry, run
modes, prior-finding chaining, and a structured report — so it becomes the
**base engine**, renamed in role to the *unified validation engine*.

### 1. One `Finding` shape

The Subsystem B Finding is already a superset. It subsumes the other two:

```
Finding {
  service,          // optional; AWS service or subsystem ("accelerator", "config")
  operation,        // optional; grouping key for the report
  fieldPath,        // what was validated (env var name, parameter, instance type)
  invalidValue,     // the offending value (optional)
  constraint,       // the rule that failed (optional)
  severity,         // 'error' | 'warning' | 'info'
  confidence,       // 'definitive' | 'medium' | 'low'
  source,           // attribution: validator name / 'cross-cutting' / 'accelerator' / 'config'
  remediationHint   // the human-readable message (this is where legacy strings live)
}
```

- Subsystem A's `{ compatible, error }` maps to a Finding with
  `severity: 'error'`, `confidence: 'definitive'`, `source: 'accelerator'`, and
  the error string in `remediationHint`. `warning` / `info` map to
  `severity: 'warning' | 'info'`. `{ compatible: true }` with no message
  produces **no** Finding.
- Subsystem C's message strings become a Finding's `remediationHint` with
  `severity: 'error'`, `confidence: 'definitive'`, `source: 'config'`.

### 2. One validator contract

`BaseValidator` (Subsystem B) is the contract: `name`, `mode`, and
`async validate(context, options) -> Array<Finding>`. Accelerator strategies and
ad-hoc validators are re-expressed as `BaseValidator` subclasses (or thin
functions the engine wraps), so a validator registered once runs through the one
engine and contributes Findings to the one report.

### 3. Adapters preserve the three legacy result shapes

Callers are migrated over several waves, not at once. Until every caller reads
Findings directly, **adapters** translate a `ValidationReport` (or a subset of
Findings) back into each legacy shape, so no caller breaks:

- `toAcceleratorResult(findings)` → `{ compatible, error?, warning?, info? }`
- `toEnvVarResult(findings)` → `{ errors[], warnings[], strategiesUsed[] }`
- `toMessageArray(findings)` → `Array<string>` (Subsystem C's
  `validateConfiguration` / `validateRequiredParameters` contract, asserted by
  `config-manager-unit.test.js`)
- `toValidField(findings)` → `{ valid, error? }` (parameter/tune-catalog shape)

The adapters are the *only* place the legacy shapes are constructed. This lets us
delete duplicate engines and merge neuron/rocm without touching call sites in the
same change.

### 4. Merge neuron + rocm; keep cuda + cpu distinct

The byte-identical neuron/rocm semver logic collapses into **one**
message-parameterized semantic-version validator (major-match, minor-`>=`),
constructed with the accelerator label and the specific mismatch message so
that:

- neuron findings still say `ml.inf2` (Inferentia guidance), and
- rocm findings still say `AMD GPU`.

`cuda` keeps its own strategy (its message and matching nuances differ), and
`cpu` stays the trivial always-compatible strategy. Merging is limited to the two
that are provably identical; distinct behavior is preserved distinctly.

**Follow-up (post-Wave 5):** the major-match/minor-`>=` *comparison rule* that
`cuda` had inlined was extracted to `src/lib/accelerator-version.js`
(`parseAcceleratorVersion` / `isMajorMinorCompatible` / `compatibleVersions`) so
`cuda` and `SemverAcceleratorValidator` share the one copy of that logic. `cuda`
remains a distinct strategy — it keeps its own g5/g6 guidance message and its
major.minor (2-segment) semantics — it just no longer re-implements the compare.

## Mapping table — every existing validator has a unified home

| Existing element | File | Legacy result shape | Unified home | Legacy shape preserved by |
| --- | --- | --- | --- | --- |
| `ValidationEngine.validateAcceleratorCompatibility` | `validation-engine.js` | `{ compatible, error?, warning?, info? }` | engine call over accelerator validators → Findings | `toAcceleratorResult` |
| `ValidationEngine.validateEnvironmentVariables` | `validation-engine.js` | `{ errors[], warnings[], strategiesUsed[] }` | `EnvVarValidator` (known-flags + community-reports strategies) → Findings | `toEnvVarResult` |
| `CudaValidator` | `cuda-validator.js` | `{ compatible, ... }` | `CudaAcceleratorValidator` (distinct strategy) | `toAcceleratorResult` |
| `NeuronValidator` | `neuron-validator.js` | `{ compatible, ... }` | `SemverAcceleratorValidator({ label:'neuron', mismatchMessage:…ml.inf2… })` | `toAcceleratorResult` |
| `RocmValidator` | `rocm-validator.js` | `{ compatible, ... }` | `SemverAcceleratorValidator({ label:'rocm', mismatchMessage:…AMD GPU… })` | `toAcceleratorResult` |
| `CpuValidator` | `cpu-validator.js` | `{ compatible: true }` | `CpuAcceleratorValidator` (trivial strategy) | `toAcceleratorResult` |
| `EnumValidator` | `validators/enum-validator.js` | `Array<Finding>` | already unified (registered validator) | native |
| `TypeValidator` | `validators/type-validator.js` | `Array<Finding>` | already unified | native |
| `RequiredFieldValidator` | `validators/required-field-validator.js` | `Array<Finding>` | already unified | native |
| `CatalogValidator` | `validators/catalog-validator.js` | `Array<Finding>` | already unified (opt-in registration) | native |
| `CrossCuttingChecker` | `cross-cutting-checker.js` | `Array` (source `cross-cutting`) | engine's cross-cutting phase → Findings | native |
| `ConfigValidator.validateConfiguration` | `config-validator.js` | `Array<string>` | config validators → Findings | `toMessageArray` |
| `ConfigValidator.validateRequiredParameters` | `config-validator.js` | `Array<string>` | required-field over CLI config → Findings | `toMessageArray` |
| `parameter-schema-validator.js` | same | `{ valid, error? }` | `ParameterSchemaValidator` → Findings | `toValidField` |
| `tune-catalog-validator.js` | same | `{ valid, error? }` | `TuneCatalogValidator` → Findings | `toValidField` |
| `e2e-catalog-validator.js` | same | `{ valid, errors:[{path,message}] }` | `E2ECatalogValidator` → Findings | `toValidField` (+ path-list variant) |
| `e2e-quota-validator.js` | same | `Array<{instanceType,required,available,sufficient}>` | `QuotaValidator` → Findings (quota fields in `constraint`/`invalidValue`) | dedicated quota adapter |
| `SchemaValidationEngine` | `schema-validation-engine.js` | `ValidationReport` | **becomes the unified engine** | native |
| `ValidationEngine` (orchestrator) | `validation-engine.js` | mixed | **retained as the accelerator/instance-matching host**; its results are normalised to Findings and rebuilt via adapters (see Implementation note) | `toAcceleratorResult` / `toEnvVarResult` |
| `AcceleratorValidator` (base) | `accelerator-validator.js` | — | **retained as the accelerator-strategy contract** (parent of the semver/cuda/cpu strategies) | — |
| `ValidationReport` | `validation-report.js` | report buckets | unchanged (the one report type) | native |

No capability is dropped: every row lands either as a native registered
validator or behind an adapter that reproduces the exact legacy shape its callers
and tests assert.

## Consequences

- **Positive:** one engine, one `BaseValidator` contract, one `Finding`/`ValidationReport`
  vocabulary. An AI maintainer asking "is this config valid?" has a single
  entrypoint and a single result type. The neuron/rocm duplication is gone. Every
  ad-hoc validator is discoverable as "a validator registered on the engine."
- **Cost:** the accelerator and ad-hoc validators are rewritten as `BaseValidator`
  subclasses; adapters are added to keep call sites and their tests green while
  migration proceeds across Wave 5 tasks.
- **Risk:** medium. Behavior must be preserved exactly through the adapters —
  covered by keeping the existing accelerator, config-manager, parameter-schema,
  catalog, e2e, generation, and validate-runner tests green, plus a new test
  proving neuron and rocm keep their distinct messages after the merge.
- **Sequencing:** T2 builds the framework + adapters (existing tests pass via
  adapters); T3 migrates accelerator validators and merges neuron/rocm; T4 makes
  the unified vocabulary real at the seams (see Implementation note).

## Implementation note (Wave 5, option A)

The original T4 plan called for physically absorbing `ValidationEngine` into
`SchemaValidationEngine` and rehosting every ad-hoc validator on the unified
engine. On implementation this was scoped down deliberately, because two of those
moves would have added translation layers with no benefit (the anti-pattern
ADR-005 warns against):

- **`ValidationEngine` is a different concern, not a redundant engine.** It does
  accelerator/instance *matching* over `{ frameworkConfig, instanceConfig }`, not
  schema/payload validation over a `ValidationContext`. Forcing it through
  `SchemaValidationEngine.validate(context)` would require synthesising a fake
  context/payload. Instead it is **retained** as the accelerator-matching host,
  and `RegistryConfigManager` normalises its results into Findings and rebuilds
  the caller shapes through `validation-adapters.js` — so the subsystem speaks the
  unified vocabulary at its boundary without a lossy merge.
- **`ConfigValidator` is deeply coupled to `ConfigManager`** (`parameterMatrix`,
  `deploymentConfigResolver`, `schemaValidator`, auto-prompt state). It already
  conforms to the unified contract through `toMessageArray`; rehosting it on the
  schema engine would gut a working, well-tested subsystem for churn.
- **`AcceleratorValidator` is retained** as the accelerator-strategy contract
  (the parent of `SemverAcceleratorValidator`, `CudaValidator`, `CpuValidator`);
  retiring it would only mean re-parenting for its own sake.

What Wave 5 **did** deliver is the substance of the unification: one `Finding`
shape, one `ValidationReport`, one `BaseValidator` contract, one adapter boundary
(`validation-adapters.js`) as the sole place legacy shapes are constructed, and
the neuron/rocm duplication collapsed. Physically collapsing the accelerator
engine and the CLI-config validator into the schema engine is filed as a backlog
item rather than forced here.

## References

- `docs/architecture/validation.md` — how the unified subsystem works today
- `src/lib/schema-validation-engine.js` — the base (unified) engine
- `src/lib/validators/base-validator.js` — the one validator contract
- `src/lib/validation-report.js` — the one report / finding vocabulary
- ADR-002 — the consolidation program
