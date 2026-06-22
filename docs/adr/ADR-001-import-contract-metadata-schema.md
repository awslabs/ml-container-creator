# ADR-001: Import Contract — MPG Customer Metadata Properties Schema

## Status

Accepted

## Context

`do/register` writes models into SageMaker Model Package Groups (MPGs) via `.register_helper.py`. Each registered Model Package version stores deployment metadata in `customer_metadata_properties` — a flat string-only key-value map constrained by SageMaker limits.

For the post-v1 `do/import` command to reconstruct a project's `do/config` from a registered model, the metadata schema must contain **all fields** needed to recreate the deployment configuration. Without a documented contract, there is no guarantee that the stored metadata is sufficient for import, and different versions of the tool may produce incompatible schemas.

This ADR documents the schema, its constraints, and the mapping from metadata keys to `do/config` variables.

## Decision

### Schema Definition

All metadata keys and values are stored as **strings** in the `customer_metadata_properties` field of each `ModelPackage`. The schema is flat (no nesting) and designed to stay well within SageMaker's constraints.

### Field Reference

| Metadata Key | do/config Variable | Description | Required for Import |
|---|---|---|---|
| `deploymentConfig` | `DEPLOYMENT_CONFIG` | Deployment configuration identifier (e.g., `gpu-vllm`, `cpu-djl`) | Yes |
| `architecture` | `ARCHITECTURE` | Model architecture family (e.g., `transformers`) | Yes |
| `backend` | `BACKEND` | Serving backend (e.g., `vllm`, `tgi`, `djl`) | Yes |
| `instanceType` | `INSTANCE_TYPE` | SageMaker instance type (e.g., `ml.g5.2xlarge`) | Yes |
| `modelName` | `MODEL_NAME` | Model identifier (e.g., `meta-llama/Llama-3.1-8B-Instruct`) | Yes |
| `baseImage` | `BASE_IMAGE` | Full ECR container image URI | Yes |
| `modelFormat` | `MODEL_FORMAT` | Model serialization format (e.g., `safetensors`) | Yes |
| `generatorVersion` | N/A | ml-container-creator version at registration time | No (informational) |
| `projectName` | `PROJECT_NAME` | Project name used as MPG group name | Yes |

### Adapter-Specific Fields (optional, present when `isAdapter == "true"`)

| Metadata Key | Description |
|---|---|
| `isAdapter` | `"true"` if this version is an adapter, absent or `"false"` otherwise |
| `parentModelVersionArn` | ARN of the base model version in the same MPG |
| `tuneTechnique` | Fine-tuning technique used (`sft`, `dpo`, `rlvr`) |
| `datasetS3Uri` | S3 URI of the training dataset |

### NFR-1 Constraints (SageMaker Limits)

The `customer_metadata_properties` field is subject to the following SageMaker-imposed constraints:

| Constraint | Limit |
|---|---|
| Maximum entries | 50 key-value pairs |
| Maximum key length | 128 characters |
| Maximum value length | 256 characters |
| Value type | String only (no numbers, booleans, objects) |

### Value Serialization Rules

1. **All values are strings.** Booleans are stored as `"true"` / `"false"`. Numbers are stored as their string representation (e.g., `"42"`).
2. **Values exceeding 256 characters are truncated** with a `"…"` (U+2026) suffix, preserving the first 255 characters. A warning is logged to stderr when truncation occurs.
3. **Empty/missing values are stored as `""`** (empty string), never omitted from the map.
4. **Keys use camelCase** to stay within the 128-char limit and follow existing SageMaker conventions.

### Current Entry Count

The base model schema uses 9 keys. Adapter versions add 4 more (13 total). Benchmark results add variable keys with `benchmark_` prefix. The design provides headroom well below the 50-entry limit for future fields.

## Consequences

### Positive

- **Import feasibility:** Any registered model version contains enough metadata to reconstruct a valid `do/config`, enabling the post-v1 `do/import` feature.
- **Round-trip verifiable:** The contract is tested via an integration test that registers a model and verifies all required fields can reconstruct the original config.
- **Backward compatible:** Adding new optional fields in future versions does not break existing consumers — unknown keys are ignored by older tools.
- **Within limits:** 9–13 keys per entry is well below the 50-entry cap, leaving room for growth.

### Negative

- **Truncation risk:** `baseImage` URIs and `modelName` paths can be long. Truncated values may not be directly usable for import without resolution logic.
- **No schema versioning:** The schema version is implicitly tied to `generatorVersion`. If a breaking change is needed, consumers must check `generatorVersion` to determine field semantics.

### Future Considerations (post-v1)

Fields that may be added after v1:

| Candidate Field | Purpose |
|---|---|
| `quantization` | Quantization method (e.g., `awq`, `gptq`) |
| `tpDegree` | Tensor parallelism degree for multi-GPU |
| `environmentOverrides` | JSON-encoded custom env vars (within 256-char limit) |
| `schemaVersion` | Explicit schema version for forward compatibility |
| `sourceRegion` | Region where the model was originally registered |

These will be added as new optional metadata keys without changing the existing schema.
