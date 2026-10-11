// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance tests for the Triton config.pbtxt template.
 *
 * These render templates/triton/config.pbtxt for EVERY backend declared in the
 * triton-backends.json catalog (derived, not hardcoded — ADR-008) and assert the
 * rendered output is a loadable Triton model configuration, never a silently
 * broken one. The failure mode this guards against: a template branch with no
 * `else`, so an unrecognized backend or model-format renders an empty required
 * field (e.g. FIL `model_type` with no `value`, or a backend with no input/output
 * tensors). Before the fallbacks were added, `--model-format=json` for triton-fil
 * rendered `parameters { key: "model_type" }` with no value — a config Triton
 * cannot load.
 *
 * The suite also renders a synthetic backend name that is NOT in the catalog to
 * prove the unknown-backend fallback produces a valid stub rather than nothing.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLlm as tritonIsLlm, isKnownBackend as isTritonBackend } from '../../src/lib/triton-backend-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_TEMPLATE_PATH = resolve(__dirname, '../../templates/triton/config.pbtxt');
const CONFIG_TEMPLATE = readFileSync(CONFIG_TEMPLATE_PATH, 'utf8');
const CATALOG_PATH = resolve(__dirname, '../../servers/lib/catalogs/triton-backends.json');
const TRITON_BACKENDS = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

// Render config.pbtxt the way src/app.js _generateTritonFiles does: backend +
// modelName (+ modelFormat for format-bearing backends) PLUS the catalog-derived
// `isLlmBackend` predicate (BL119 — the template branches on it instead of a
// hardcoded vllm/tensorrtllm name list). Deriving it here from the same reader the
// generator uses makes this a true conformance check of that derivation.
function renderConfig(overrides = {}) {
    const vars = {
        backend: 'fil',
        modelName: 'model',
        modelFormat: null,
        ...overrides
    };
    const backend = vars.backend;
    vars.isLlmBackend = isTritonBackend(backend) && tritonIsLlm(backend);
    return ejs.render(CONFIG_TEMPLATE, vars);
}

// A rendered Triton config must never contain a parameter value with an empty
// string_value, and must never contain a `key:` immediately followed by a `}`
// (a parameter whose `value:` branch rendered nothing).
function assertNoEmptyParameterValues(output, context) {
    assert.ok(
        !/string_value:\s*""\s*}/.test(output),
        `${context}: rendered an empty string_value (broken parameter)`
    );
    // A `parameters { key: "X" }` block with no `value:` line at all.
    assert.ok(
        !/key:\s*"[^"]+"\s*\n\s*}/.test(output),
        `${context}: rendered a parameter with a key but no value (broken parameter)`
    );
}

// Every backend has a stable, format-independent model-format sample set derived
// from the catalog so new backends/formats are exercised automatically.
function modelFormatsFor(backendMeta) {
    const formats = backendMeta.modelFormats;
    return Array.isArray(formats) && formats.length > 0 ? formats : [null];
}

describe('Triton config.pbtxt conformance (derived from triton-backends.json)', () => {
    it('the catalog is non-empty (guards against an empty derivation silently passing)', () => {
        assert.ok(
            Object.keys(TRITON_BACKENDS).length > 0,
            'triton-backends.json must declare at least one backend'
        );
    });

    for (const [backend, meta] of Object.entries(TRITON_BACKENDS)) {
        describe(`backend: ${backend}`, () => {
            for (const modelFormat of modelFormatsFor(meta)) {
                const label = modelFormat ? `model-format=${modelFormat}` : 'no model-format';

                it(`renders a loadable config.pbtxt (${label})`, () => {
                    const modelName = meta.requiresModelName ? 'org/some-model' : 'model';
                    const output = renderConfig({ backend, modelName, modelFormat });

                    // Core identity fields must be present and non-empty.
                    assert.ok(
                        new RegExp(`name:\\s*"${modelName}"`).test(output),
                        `${backend}/${label}: config must set name to the model name`
                    );
                    assert.ok(
                        new RegExp(`backend:\\s*"${backend}"`).test(output),
                        `${backend}/${label}: config must set backend to "${backend}"`
                    );

                    // No parameter may render with a missing/empty value.
                    assertNoEmptyParameterValues(output, `${backend}/${label}`);
                });
            }

            if (Array.isArray(meta.modelFormats) && meta.modelFormats.length > 0) {
                it('every catalog model-format produces a non-empty model_type (FIL-style)', () => {
                    // Only FIL emits a model_type parameter; for other format-bearing
                    // backends this still asserts the general no-empty-value contract.
                    for (const modelFormat of meta.modelFormats) {
                        const output = renderConfig({ backend, modelFormat, modelName: 'model' });
                        assertNoEmptyParameterValues(output, `${backend}/${modelFormat}`);
                    }
                });
            }
        });
    }

    describe('FIL model_type mapping', () => {
        // The CLI's --model-format enum (schema) allows the HTTP-xgboost names
        // json/ubj/model; the FIL template must accept those AND the FIL-native
        // names, mapping every XGBoost-shaped format to model_type "xgboost_json"
        // and lightgbm_txt to "lightgbm" — with NO warning for recognized values.
        for (const fmt of ['json', 'ubj', 'model', 'xgboost_json', 'xgboost_ubj']) {
            it(`maps recognized XGBoost format "${fmt}" to model_type xgboost_json without a warning`, () => {
                const output = renderConfig({ backend: 'fil', modelFormat: fmt, modelName: 'model' });
                assertNoEmptyParameterValues(output, `fil/${fmt}`);
                assert.ok(
                    /key:\s*"model_type"[\s\S]*?string_value:\s*"xgboost_json"/.test(output),
                    `FIL "${fmt}" should render model_type xgboost_json`
                );
                assert.ok(
                    !/WARNING: unrecognized model-format/.test(output),
                    `FIL "${fmt}" is a recognized format and must NOT emit the fallback warning`
                );
            });
        }

        it('maps lightgbm_txt to model_type lightgbm', () => {
            const output = renderConfig({ backend: 'fil', modelFormat: 'lightgbm_txt', modelName: 'model' });
            assert.ok(
                /key:\s*"model_type"[\s\S]*?string_value:\s*"lightgbm"/.test(output),
                'FIL lightgbm_txt should render model_type lightgbm'
            );
            assert.ok(!/WARNING/.test(output), 'lightgbm_txt is recognized — no warning');
        });

        it('a genuinely unrecognized model-format still renders a non-empty model_type with a warning', () => {
            // 'pkl' is a valid --model-format enum value but is NOT an XGBoost/LightGBM
            // format, so for the FIL backend it is unrecognized and must fall back
            // (non-empty model_type + visible warning) rather than render empty.
            const output = renderConfig({ backend: 'fil', modelFormat: 'pkl', modelName: 'model' });
            assertNoEmptyParameterValues(output, 'fil/pkl (unrecognized for FIL)');
            assert.ok(
                /key:\s*"model_type"[\s\S]*?string_value:\s*"xgboost_json"/.test(output),
                'FIL fallback should default an unrecognized model-format to xgboost_json'
            );
            assert.ok(
                /WARNING: unrecognized model-format/.test(output),
                'FIL fallback should emit a visible warning comment for an unrecognized format'
            );
        });
    });

    describe('unknown-backend fallback', () => {
        it('a backend with no dedicated template arm still renders input/output tensors', () => {
            // Simulate a backend added to the catalog before a template arm exists.
            const output = renderConfig({ backend: 'some-future-backend', modelName: 'model' });
            assert.ok(
                /backend:\s*"some-future-backend"/.test(output),
                'unknown backend name should still be written'
            );
            assert.ok(
                /input\s*\[[\s\S]*?name:\s*"INPUT"/.test(output),
                'unknown-backend fallback must render an input tensor'
            );
            assert.ok(
                /output\s*\[[\s\S]*?name:\s*"OUTPUT"/.test(output),
                'unknown-backend fallback must render an output tensor'
            );
            assert.ok(
                /no tailored config template/.test(output),
                'unknown-backend fallback should emit a visible explanatory comment'
            );
            assertNoEmptyParameterValues(output, 'some-future-backend');
        });
    });

    describe('LLM backends (vllm, tensorrtllm)', () => {
        for (const backend of ['vllm', 'tensorrtllm']) {
            it(`${backend} sets the model parameter from modelName`, () => {
                const output = renderConfig({ backend, modelName: 'meta-llama/Llama-3.1-8B-Instruct' });
                assert.ok(
                    /key:\s*"model"[\s\S]*?string_value:\s*"meta-llama\/Llama-3\.1-8B-Instruct"/.test(output),
                    `${backend}: model parameter must carry the model name`
                );
                assertNoEmptyParameterValues(output, backend);
            });
        }
    });
});
