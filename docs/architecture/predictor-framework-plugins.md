<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Predictor-Framework Plugins

> **Audience.** Maintainers extending MLCC's HTTP "predictor" model servers — the
> classical-ML frameworks (scikit-learn, XGBoost, TensorFlow) served behind Flask
> or FastAPI under the `http-flask` / `http-fastapi` deployment configs.
>
> **Companion.** This is the predictor analogue of
> [Serve-Engine Plugin Authoring](serve-engine-plugin-authoring.md). Read that too
> — but note the deliberate difference below.

## Predictors are a *descriptor + handler* plugin, not a pure-data plugin

A serve engine's base image (vLLM, SGLang, an AWS DLC) **already contains the
server**, so a serve-engine plugin's whole contract reduces to data in a
`manifest.json` and the `<engine>.ejs` is a thin launch wrapper.

A predictor is the opposite: MLCC **ships the server code itself** — `serve.py`
plus a per-framework `ModelHandler` that really calls `joblib.load()` /
`xgb.Booster().load_model()` / `tf.keras.models.load_model()`. That load/predict
logic is imperative Python; it does not reduce to manifest fields.

So a predictor plugin is a **hybrid**:

- **`manifest.json`** — the part that *is* data (model formats, pip dependencies,
  default format, test payload, base-image catalog key). This is the part that was
  previously duplicated across `config-validator.js`, `model-prompts.js`,
  `config-manager.js`, `requirements.txt`, and the Dockerfile — now a single source.
- **`handler.py`** — the part that *is* code (the `ModelHandler`). The manifest
  references it by filename; it is materialized into the generated project as
  `code/model_handler.py`, not reduced to config.

Do not try to express `handler.py` as data — that is where the serve-engine
analogy breaks, and forcing it would turn clear code into a config-driven
code-generator.

## Two orthogonal axes

Predictors vary along two independent axes:

- **Framework** (sklearn / xgboost / tensorflow) — the plugin axis. Owns the
  model formats, pip deps, load/predict handler.
- **Web server** (flask / fastapi) — NOT part of the framework plugin. The
  `serve.py` app shell, request parse, response serialize, and the
  `start_server.py` gunicorn-vs-uvicorn choice stay as the orthogonal `modelServer`
  EJS branch. `serve.py` is framework-agnostic (it only references `ModelHandler`),
  so the two axes are cleanly separable.

## Anatomy of a plugin

```
templates/code/predictors.d/
├── manifest.schema.json          # validates every predictor manifest
├── sklearn/
│   ├── manifest.json
│   └── handler.py                # ModelHandler (materialized → code/model_handler.py)
├── xgboost/
│   ├── manifest.json
│   └── handler.py
└── tensorflow/
    ├── manifest.json
    └── handler.py
```

The whole `predictors.d/**` tree is excluded from generated output (the broad
ignore glob in `src/app.js`, like `serve.d/**`). Only the selected framework's
handler is rendered into the project.

### The manifest contract

| Field | Required | Meaning |
|---|:---:|---|
| `framework` | ✓ | Framework name; must equal the directory name. |
| `display_name` | ✓ | Label shown in the interactive engine prompt (e.g. `scikit-learn`). |
| `model_formats` | ✓ | File formats the framework loads (e.g. `[pkl, joblib]`). The CLI `--model-format` and the prompt derive their set from this. |
| `default_model_format` | ✓ | Default when unset; must be one of `model_formats` (enforced by the conformance test). |
| `pip_dependencies` | ✓ | Pinned pip lines rendered into the generated `requirements.txt`. |
| `base_image_catalog` | ✓ | Base-image catalog key; `python-slim` for all three. |
| `handler` | ✓ | Handler filename (`handler.py`). |
| `test_payload` | ✓ | The `do/test` sample `/invocations` body. |

The schema (`predictors.d/manifest.schema.json`) enforces shape with
`additionalProperties: false`.

### The reader

`src/lib/predictor-manifest-reader.js` is the single consumer-facing reader
(mirrors `serve-manifest-reader.js`). It discovers frameworks dynamically by
scanning `predictors.d/` for `manifest.json`, and exposes
`listPredictorFrameworks()`, `modelFormats`, `defaultModelFormat`,
`pipDependencies`, `testPayload`, `displayName`, `handlerPath`, plus the aggregate
maps `modelFormatsMap()`, `defaultModelFormatMap()`, and `formatToEngineMap()`
that the validator/prompts/config-manager derive from.

Unlike serve.d, there is **no deploy-time Python twin**: predictor descriptors are
consumed entirely at generation time (the generated project ships a concrete
`model_handler.py` and `requirements.txt` with nothing left to read at deploy
time). A `predictor_manifest.py` twin would only be added if a future need to read
predictor data at deploy time arises.

## Adding a framework — checklist

1. **Create** `templates/code/predictors.d/<framework>/manifest.json` (schema-valid)
   and `handler.py` (a `ModelHandler` with `load_model` / `is_loaded` /
   `preprocess` / `predict` / `postprocess`). The handler is EJS-rendered, so you
   may use `<%= modelFormat %>` in its file-glob as the shipped ones do.
2. **Nothing else is hand-wired for the data path.** The reader discovers the
   framework; `config-validator.js` (accepted formats, engines, default format),
   `model-prompts.js` (engine choice, format choices), `config-manager.js` (format→
   engine inference, default format), `requirements.txt` (pip deps), and the
   handler materialization in `src/app.js` all derive from the descriptor.
3. **Verify:**
   - `npx mocha test/unit/predictor-framework-conformance.test.js` — the drift
     guard. It asserts validator-formats == prompt-formats == manifest
     `model_formats` for every framework, `default_model_format ∈ model_formats`,
     a handler + non-empty pip deps per framework, and schema validity. A new
     framework that drifts from its consumers fails here with the exact mismatch.
   - `npm run lint` and an **end-to-end generate**:
     `node bin/cli.js <name> --project-dir /tmp/<name> --deployment-config=http-flask
     --model-format=<a format of your framework> --deployment-target=realtime-inference
     --instance-type=ml.m5.large --build-target=codebuild --region=us-east-1 --skip-prompts`.
     The engine is inferred from `--model-format` via the descriptor
     `formatToEngineMap()`. Inspect the generated `code/model_handler.py`,
     `requirements.txt`, and `do/test`.
4. **Document** the framework if it warrants a user-facing example in
   [EXAMPLES](../EXAMPLES.md).

## Why this shape (vs. the serve-engine plugin)

| | Serve-engine plugin | Predictor plugin |
|---|---|---|
| Server code lives in | the base image | MLCC's `handler.py` + `serve.py` |
| Manifest reduces the whole contract? | yes (pure data) | no — data + a referenced handler |
| Deploy-time reader | `serve_manifest.py` | none (generation-time only) |
| Axes | one (engine) | two (framework × web server) |

The predictor system took the serve-engine *discipline* (single-source-of-truth
descriptor, dynamic discovery, a conformance/drift test) and applied it to the
part of the predictors that is genuinely data — collapsing the previously
duplicated per-framework format/deps/default maps — while leaving the imperative
load/predict logic as code behind each plugin.
