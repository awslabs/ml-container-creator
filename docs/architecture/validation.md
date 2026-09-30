<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Validation Framework

ml-container-creator answers one recurring question — *is this configuration
valid, and if not, what should the user change?* — from a **single engine, a
single validator contract, and a single finding vocabulary**. This explainer
describes the unified subsystem the codebase is converging on; see
[ADR-006](../adr/ADR-006-unified-validation-framework.md) for the decision and
the full mapping from the three legacy subsystems, and
[system-overview.md](system-overview.md) for where validation sits in the layer
map (config/intent boundary, before writing/template).

> **User-facing counterpart:** `dev/validation-system.md` documents validation
> from the *user's* perspective (what smart mode does, how to read a report).
> This page is the *maintainer's* structural map.

## One contract: `BaseValidator`

`src/lib/validators/base-validator.js` is the one contract every validator
implements:

- **`name`** — source attribution stamped onto each finding.
- **`mode`** — `'static'` (always run), `'smart'` (only with `--smart`), or
  `'both'`.
- **`async validate(context, { priorFindings, serviceModels }) -> Array<Finding>`**
  — inspect the context, return findings. Earlier validators' findings are passed
  in `priorFindings` so a validator can react to what came before.

A validator registered once runs through the one engine and contributes to the
one report. There is no second base class.

## One vocabulary: `Finding` and `ValidationReport`

A **Finding** is the atom of validation output:

```
Finding {
  service,          // subsystem/service: "accelerator", "config", an AWS service…
  operation,        // grouping key for the report
  fieldPath,        // what was checked: env var, parameter, instance type…
  invalidValue,     // the offending value (optional)
  constraint,       // the rule that failed (optional)
  severity,         // 'error' | 'warning' | 'info'
  confidence,       // 'definitive' | 'medium' | 'low'
  source,           // attribution: validator name / 'cross-cutting' / 'accelerator' / 'config'
  remediationHint   // the human-readable message
}
```

`src/lib/validation-report.js` (`ValidationReport`) is the one aggregator.
`addFinding` routes each finding into a bucket by `source`, `confidence`, and
`severity`:

- `schemaErrors` — definitive schema failures.
- `crossCuttingErrors` — high-confidence cross-cutting failures.
- `advisoryFindings` — smart-mode and medium/low-confidence findings (advisory,
  never blocking).
- `warnings` — non-fatal issues.

`toText()` renders a color-coded, operation-grouped report; `toJSON()` emits the
structured object; `getSummary()` gives `{ errors, warnings, advisory, fieldsValidated }`.

## One engine

`src/lib/schema-validation-engine.js` (`SchemaValidationEngine`) is the unified
engine. `validate(context)` runs a fixed pipeline and returns a
`ValidationReport`:

1. **Static phase** — every validator whose `mode` is `static` or `both`, in
   registration order, chaining `priorFindings`.
2. **Cross-cutting phase** — `CrossCuttingChecker.check(context, instanceCatalog)`
   when an instance catalog is present (checks that span multiple fields).
3. **Smart phase** — when `smartMode` is on, validators whose `mode` is `smart`
   or `both` (skipping `both` validators already run statically).

A throwing validator is caught and downgraded to an engine warning, so one bad
plugin never aborts the run. `registerValidator(validator)` adds a plugin;
`checkStaleness()` reports how old the synced schema registry is. `EnumValidator`,
`TypeValidator`, and `RequiredFieldValidator` auto-register;
`CatalogValidator` registers opt-in.

## Adapters: preserving legacy result shapes during migration

Historically the same "is it valid?" question was answered by three engines in
three vocabularies. Callers are migrated to read `Finding`s over several Wave 5
tasks; until then, **adapters** are the single place legacy shapes are rebuilt
from findings, so no call site breaks mid-migration:

| Adapter | Produces | Serves |
|---|---|---|
| `toAcceleratorResult(findings)` | `{ compatible, error?, warning?, info? }` | accelerator-compat callers in `registry-config-manager.js` |
| `toEnvVarResult(findings)` | `{ errors[], warnings[], strategiesUsed[] }` | env-var validation in `template-variable-resolver.js` |
| `toMessageArray(findings)` | `Array<string>` | `ConfigValidator.validateConfiguration` / `validateRequiredParameters` (asserted by `config-manager-unit.test.js`) |
| `toValidField(findings)` | `{ valid, error? }` | parameter-schema / tune-catalog callers |

When migration is complete, adapters are the only compatibility surface; the
engine and report are always the source of truth.

## Accelerator validators: one merged semver strategy

Accelerator compatibility (framework's required accelerator vs an instance's
capabilities) is expressed as validators over the one engine:

- **cuda** — its own strategy (distinct message and matching nuances).
- **cpu** — trivial always-compatible strategy.
- **neuron & rocm** — one message-parameterized semantic-version validator
  (major must match, minor must be `>=`), constructed with a label and mismatch
  message. The two were byte-identical, so they share code, **but keep distinct
  messages**: neuron findings still guide toward `ml.inf2` (Inferentia), rocm
  findings still say `AMD GPU`. A test asserts these messages survive the merge.

## Entry points

Validation is invoked from three places; all resolve to the one engine:

- **`do/validate`** → `validate-runner.js` — full schema validation of a
  generated project (`--smart` toggles the smart phase).
- **Dry-run / prove** → `dry-run-validator.js` (`{ passed, report, skipped }`)
  and `generation-validator.js` (`{ skipped, report }`) — pre-generation gates.
- **`src/app.js`** — CLI config validation (via `ConfigValidator`, through the
  message-array adapter), required-parameter checks, and accelerator/env-var
  validation (via `registry-config-manager.js` and `template-variable-resolver.js`).

## File map

| File | Role |
|---|---|
| `src/lib/schema-validation-engine.js` | the unified engine (static → cross-cutting → smart) |
| `src/lib/validators/base-validator.js` | the one validator contract |
| `src/lib/validators/{enum,type,required-field,catalog}-validator.js` | built-in validators |
| `src/lib/cross-cutting-checker.js` | multi-field checks (cross-cutting phase) |
| `src/lib/validation-report.js` | the one report / finding aggregator |
| `src/lib/config-validator.js` | CLI config checks (findings via message-array adapter) |
| `src/lib/{parameter-schema,tune-catalog,e2e-catalog,e2e-quota}-validator.js` | domain validators folded onto the contract |
| `validate-runner.js`, `dry-run-validator.js`, `generation-validator.js` | entry points / gates |

## Retained, but speaking the unified vocabulary

Wave 5 deliberately did **not** physically collapse two subsystems into the
schema engine (see the ADR-006 Implementation note for why forcing that would add
translation layers with no benefit):

- `src/lib/validation-engine.js` (`ValidationEngine`) is **retained** as the
  accelerator/instance-matching host. `RegistryConfigManager` normalises its
  results into Findings and rebuilds the caller shapes through the adapters, so
  the boundary speaks the unified vocabulary without a lossy merge.
- `src/lib/accelerator-validator.js` (`AcceleratorValidator`) is **retained** as
  the accelerator-strategy contract — the parent of `SemverAcceleratorValidator`,
  `CudaValidator`, and `CpuValidator`.
- `src/lib/config-validator.js` (`ConfigValidator`) stays coupled to
  `ConfigManager` and conforms to the unified contract through `toMessageArray`.

The unification's substance — one `Finding` shape, one report, one
`BaseValidator` contract, one adapter boundary, and de-duplicated neuron/rocm —
is delivered. Physically merging the accelerator engine and CLI-config validator
into the schema engine is tracked as a backlog item.

See [ADR-006](../adr/ADR-006-unified-validation-framework.md) for the complete
per-validator mapping table proving no capability is lost.
