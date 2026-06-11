# Validation System

MCC includes a plugin-based validation engine that checks user configuration against AWS service model constraints and cross-cutting consistency rules. It catches deployment errors at generation time — before you spend 10 minutes building a container only to have `CreateEndpoint` reject your payload.

---

## Architecture

```
User Configuration (CLI flags, env vars, config file)
         │
         ▼
   PayloadBuilder          ← Translates config into API payloads
         │
         ▼
SchemaValidationEngine     ← Orchestrator
         │
         ├── Static Validators (always run)
         │     ├── EnumValidator
         │     ├── TypeValidator
         │     └── RequiredFieldValidator
         │
         ├── CrossCuttingChecker (always run, needs instance catalog)
         │     ├── GPU Consistency
         │     ├── Tensor Parallelism
         │     ├── Model Source Requirements
         │     ├── Role ARN Format
         │     ├── CUDA Compatibility
         │     ├── Model Type / Instance Alignment
         │     ├── KV Cache Memory Fit
         │     └── Marketplace Compatibility
         │
         └── Smart Validators (only when --smart is enabled)
               └── (Future: MCP-based validators)
         │
         ▼
   ValidationReport        ← Categorized findings with severity
```

---

## When Validation Runs

Validation runs at two points in the lifecycle:

### 1. Generation Time (non-blocking)

After project generation, `runGenerationValidation()` in `src/lib/generation-validator.js` runs the engine and prints findings as warnings. It does NOT block generation — you always get your project, even if validation finds issues.

```
ml-container-creator my-project --deployment-config=transformers-vllm ...
                                                │
                                                ▼
                                    Project generated ✅
                                                │
                                                ▼
                                    ⚠️ Validation: 2 warnings
                                       • VLLM_TENSOR_PARALLEL_SIZE ≠ instance GPU count
                                       • KV cache may exceed VRAM
```

Skips silently if:
- Schema registry is not synced (`~/.ml-container-creator/schemas/` missing)
- `--no-validate` flag is passed

### 2. Explicit via `do/validate` (blocking)

The generated `do/validate` script runs validation against the existing `do/config` and exits with code 1 if errors are found:

```bash
./do/validate          # Full validation
./do/validate --smart  # Include smart-mode validators
./do/validate --json   # Output as JSON (for CI)
```

This calls `src/lib/validate-runner.js` which parses `do/config`, builds payloads, and runs the engine.

---

## Plugin Interface (BaseValidator)

All validators extend `BaseValidator` in `src/lib/validators/base-validator.js`:

```javascript
import BaseValidator from './base-validator.js';

export default class MyValidator extends BaseValidator {
    get name() {
        return 'my-validator';  // Used in finding.source for attribution
    }

    get mode() {
        return 'static';  // 'static' | 'smart' | 'both'
    }

    async validate(context, options) {
        const findings = [];
        // context.payloads — API payloads keyed by "service:operation"
        // context.config — raw configuration values
        // options.priorFindings — findings from earlier validators
        // options.serviceModels — parsed AWS service models
        return findings;
    }
}
```

### Plugin Modes

| Mode | When It Runs | Use Case |
|---|---|---|
| `static` | Always | Schema-level checks (enum, type, required fields) |
| `smart` | Only with `--smart` flag | Checks requiring external data (MCP queries, live API calls) |
| `both` | Always, but smart-specific logic only in smart mode | Validators that have both offline and online checks |

**Ordering:** Static validators run first, then cross-cutting checks, then smart validators. Within each group, validators run in registration order.

---

## Built-in Validators

### EnumValidator (`src/lib/validators/enum-validator.js`)

Validates that payload field values are within the allowed enum set defined in the AWS service model. Recursively validates nested structures and list elements.

**Mode:** `static`

**Example finding:**
```
✗ InstanceType: "ml.g5.xbig" — Value not valid. Allowed: ml.g5.xlarge, ml.g5.2xlarge, ...
```

### TypeValidator (`src/lib/validators/type-validator.js`)

Validates field types (string, integer, float, boolean, list), numeric min/max range constraints, string length constraints, and regex pattern constraints.

**Mode:** `static`

**Example finding:**
```
✗ InitialInstanceCount: "2" — Expected an integer value but got string.
✗ EndpointName: "my endpoint!" — Does not match pattern: ^[a-zA-Z0-9](-*[a-zA-Z0-9])*
```

### RequiredFieldValidator (`src/lib/validators/required-field-validator.js`)

Validates that all required fields in an operation's input shape are present and non-empty. Recursively checks nested structures.

**Mode:** `static`

**Example finding:**
```
✗ ModelName: undefined — Required field "ModelName" is missing in CreateModel.
```

### CatalogValidator (`src/lib/validators/catalog-validator.js`)

Validates that catalog entries (e.g., `model-servers.json`) contain valid enum values according to the AWS service model. Unlike other validators that check API payloads, this validates the internal catalog data itself.

**Mode:** `static`

---

## Cross-Cutting Checker

The `CrossCuttingChecker` (`src/lib/cross-cutting-checker.js`) validates consistency rules that span multiple configuration fields and require the instance catalog. It runs after schema validators.

### Checks

| Check | What It Validates | Severity |
|---|---|---|
| **GPU Consistency** | `IC_GPU_COUNT` matches instance's actual GPU count | error |
| **Tensor Parallelism** | `VLLM_TENSOR_PARALLEL_SIZE` == `IC_GPU_COUNT` == instance GPUs (three-way match) | error |
| **Model Source Requirements** | When `modelSource` is `s3` or `registry`, `MODEL_ARTIFACT_URI` must be set | error |
| **Role ARN Format** | `ROLE_ARN` matches `arn:aws:iam::\d{12}:role/.+` pattern | error |
| **CUDA Compatibility** | Base image CUDA major version intersects instance's supported CUDA versions | error |
| **Model Type / Instance Alignment** | Predictor models shouldn't use GPU instances (cost warning) | warning |
| **KV Cache Memory Fit** | Estimated VRAM (weights + KV cache + overhead) fits in instance total GPU memory | warning |
| **Marketplace Compatibility** | Model package ARN format, subscription status, instance support, LoRA incompatibility | error/warning |

### Example findings:

```
✗ NumberOfAcceleratorDevicesRequired: 1 does not match GPU count (4) for ml.g5.12xlarge.
  Set IC_GPU_COUNT to 4.

✗ VLLM_TENSOR_PARALLEL_SIZE: 2 must equal instance GPU count (4) for ml.g5.12xlarge.

ℹ Estimated VRAM needed: 28.5GB exceeds instance capacity (24GB).
  Reduce VLLM_MAX_MODEL_LEN, use quantization, or select a larger instance.
```

---

## Finding Object Structure

Every finding returned by validators follows this shape:

```javascript
{
    service: 'sagemaker',                    // AWS service name
    operation: 'CreateEndpointConfig',       // API operation being validated
    fieldPath: 'ProductionVariants[0].InstanceType',  // Dot-notation path
    invalidValue: 'ml.g5.xbig',             // The bad value
    constraint: {
        type: 'enum',                        // enum | type | required | pattern | range | gpu-consistency | ...
        values: ['ml.g5.xlarge', ...]        // Constraint-specific metadata
    },
    severity: 'error',                       // error | warning
    confidence: 'definitive',               // definitive | high | medium | low
    source: 'enum',                          // Validator name (for attribution)
    remediationHint: 'Value "ml.g5.xbig" is not valid. Allowed values: ...'
}
```

### Confidence Levels

| Level | Meaning | Effect on Report Categorization |
|---|---|---|
| `definitive` | Guaranteed to be wrong (service will reject) | Schema error or cross-cutting error |
| `high` | Very likely wrong based on catalog data | Error (unless severity is warning) |
| `medium` | Possibly wrong, needs human review | Advisory finding |
| `low` | Informational, may be fine | Advisory finding |

---

## Validation Report

`ValidationReport` (`src/lib/validation-report.js`) categorizes findings into 4 buckets:

| Category | Color | Contents |
|---|---|---|
| **Schema Errors** | Red | High-confidence schema violations |
| **Cross-Cutting Errors** | Red | High-confidence consistency violations |
| **Advisory Findings** | Cyan | Medium/low confidence findings, smart-mode results |
| **Warnings** | Yellow | Engine-level warnings (plugin errors, staleness) |

### Output Formats

**Text (default):**
```
── Schema Errors ──
  CreateEndpointConfig:
    ✗ InstanceType: ml.g5.xbig (Value not valid. Allowed: ...)

── Cross-Cutting Errors ──
  configuration:
    ✗ VLLM_TENSOR_PARALLEL_SIZE: must equal instance GPU count (4)

── Advisory Findings ──
  configuration:
    ℹ INSTANCE_TYPE: Estimated VRAM exceeds capacity

Summary: 2 error(s), 0 warning(s), 1 advisory, 14 fields validated
```

**JSON (`--json`):**
```json
{
  "schemaErrors": [...],
  "crossCuttingErrors": [...],
  "advisoryFindings": [...],
  "warnings": [...],
  "metadata": { "fieldsValidated": 14 },
  "summary": { "errors": 2, "warnings": 0, "advisory": 1, "fieldsValidated": 14 }
}
```

---

## Service Models and Schema Registry

The validation engine validates against **actual AWS service model definitions** (the same JSON specs that define the SageMaker AI API). These are synced locally via:

```bash
ml-container-creator bootstrap sync-schemas
```

This downloads service model JSON files to `~/.ml-container-creator/schemas/` and creates a `manifest.json` with sync timestamp.

### Staleness Detection

If the schema registry is >30 days old, the engine prints a warning:

```
⚠️  Schema registry is 45 days old. Run `ml-container-creator bootstrap sync-schemas` to update.
```

Pass `--ignore-staleness` or set `ignoreStaleness: true` in engine options to suppress.

---

## Adding a New Validator

### Step 1: Create the validator file

```javascript
// src/lib/validators/my-custom-validator.js
import BaseValidator from './base-validator.js';

export default class MyCustomValidator extends BaseValidator {
    get name() { return 'my-custom'; }
    get mode() { return 'static'; }

    async validate(context, options) {
        const findings = [];

        // Access configuration
        const config = context.config || {};

        // Example: warn if using deprecated option
        if (config.SOME_DEPRECATED_FIELD) {
            findings.push({
                service: 'ml-container-creator',
                operation: 'configuration',
                fieldPath: 'SOME_DEPRECATED_FIELD',
                invalidValue: config.SOME_DEPRECATED_FIELD,
                constraint: { type: 'deprecated' },
                severity: 'warning',
                confidence: 'definitive',
                source: this.name,
                remediationHint: 'SOME_DEPRECATED_FIELD is deprecated. Use NEW_FIELD instead.'
            });
        }

        return findings;
    }
}
```

### Step 2: Register in the engine

Add an import and `registerValidator()` call in `src/lib/schema-validation-engine.js`:

```javascript
import MyCustomValidator from './validators/my-custom-validator.js';

// In the constructor:
this.registerValidator(new MyCustomValidator());
```

### Step 3: Add tests

Create a property test in `test/property/` or unit test in `test/unit/`:

```javascript
import { describe, it } from 'mocha';
import assert from 'node:assert';
import MyCustomValidator from '../../src/lib/validators/my-custom-validator.js';

describe('MyCustomValidator', () => {
    it('warns on deprecated field', async () => {
        const validator = new MyCustomValidator();
        const context = { config: { SOME_DEPRECATED_FIELD: 'value' }, payloads: {} };
        const findings = await validator.validate(context, { serviceModels: [], priorFindings: [] });
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].severity, 'warning');
    });
});
```

---

## Adding a Cross-Cutting Check

Add a new method to `CrossCuttingChecker` and call it from `check()`:

```javascript
// In src/lib/cross-cutting-checker.js

check(context, instanceCatalog) {
    const findings = [];
    // ... existing checks ...
    findings.push(...this.checkMyNewRule(context, instanceCatalog));
    return findings;
}

checkMyNewRule(context, instanceCatalog) {
    const findings = [];
    const config = context.config || {};

    // Your consistency logic here

    if (/* inconsistency detected */) {
        findings.push({
            service: 'cross-cutting',
            operation: 'configuration',
            fieldPath: 'MY_FIELD',
            invalidValue: config.MY_FIELD,
            constraint: { type: 'my-rule-type', /* details */ },
            severity: 'error',
            confidence: 'high',
            source: 'cross-cutting',
            remediationHint: 'Human-readable fix instruction.'
        });
    }

    return findings;
}
```

---

## ConfigValidator vs SchemaValidationEngine

MCC has two validation layers:

| Layer | File | When | Blocking? | What It Checks |
|---|---|---|---|---|
| **ConfigValidator** | `src/lib/config-validator.js` | During configuration assembly | Yes (aborts generation) | Hard rules: invalid deployment configs, incompatible architecture+backend combos, missing required fields for specific targets |
| **SchemaValidationEngine** | `src/lib/schema-validation-engine.js` | After generation / via `do/validate` | No (warnings only at gen-time) | AWS API contract validation, cross-cutting consistency |

`ConfigValidator` uses the generated `validation-rules.js` (from the parameter schema codegen pipeline) and checks business logic. `SchemaValidationEngine` validates against the actual AWS API shapes.

---

## Smart Mode (Future)

When `--smart` is passed, the engine also runs validators with `mode: 'smart'`. These can:

- Query MCP servers for live data (instance availability, quota)
- Call AWS APIs to verify resources exist (endpoints, roles, buckets)
- Check model registry for compatibility metadata

Smart validators' findings are categorized as **advisory** unless confidence is `definitive` and severity is `error`. This prevents false positives from blocking deployment.

Currently no smart validators are registered — the infrastructure is in place for future extension.
