// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Predictor-framework plugin conformance (ADR-006/007/008 drift guard).
 *
 * WHY THIS EXISTS
 * ---------------
 * The HTTP predictor frameworks (sklearn/xgboost/tensorflow) are a descriptor +
 * handler plugin: predictors.d/<framework>/manifest.json declares the data
 * (model_formats, default_model_format, pip_dependencies, test_payload) and
 * handler.py carries the code. Before this system, the per-framework model-format
 * set was independently hardcoded in config-validator.js AND model-prompts.js (and
 * the default-format and format→engine maps in a third and fourth place), with no
 * test tying the copies together — the silent-divergence class the repo's
 * "derive, don't hardcode" steering exists to prevent.
 *
 * This test makes the descriptor the single source of truth LOUD: for every
 * framework discovered under predictors.d/, the formats the validator accepts, the
 * formats the interactive prompt offers, and the manifest's model_formats must all
 * agree; the default format must be one of them; and every framework must ship a
 * handler and non-empty pip dependencies. A non-vacuous guard asserts at least one
 * framework was discovered so the suite cannot silently pass on an empty scan.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import Ajv from 'ajv/dist/2020.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    listPredictorFrameworks,
    readPredictorManifest,
    modelFormats,
    defaultModelFormat,
    pipDependencies,
    handlerPath,
    modelFormatsMap,
    defaultModelFormatMap,
    formatToEngineMap
} from '../../src/lib/predictor-manifest-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PREDICTORS_D = resolve(ROOT, 'templates', 'code', 'predictors.d');
const SCHEMA_PATH = resolve(PREDICTORS_D, 'manifest.schema.json');

// The two consumer surfaces we assert agreement against.
// config-validator exposes its accepted formats via the private _getSupportedOptions,
// which derives from the reader; we assert against the reader-built map it uses.
import ConfigValidator from '../../src/lib/config-validator.js';

// Build the validator's supportedOptions through a minimal manager stub so we
// exercise the real _getSupportedOptions code path (not a reimplementation).
function validatorModelFormats() {
    const stubManager = {
        deploymentConfigResolver: { getAllConfigs: () => [] }
    };
    const cv = new ConfigValidator(stubManager);
    return cv._getSupportedOptions().modelFormats;
}

// The interactive prompt's model-format choices for a given engine, exercised
// through the real prompt definition.
import { modelFormatPrompts } from '../../src/lib/prompts/model-prompts.js';

function promptModelFormats(engine) {
    const fmtPrompt = modelFormatPrompts.find((p) => p.name === 'modelFormat');
    assert.ok(fmtPrompt, 'model-prompts must define a modelFormat prompt');
    return fmtPrompt.choices({ architecture: 'http', engine });
}

describe('Predictor-framework plugin conformance (predictors.d)', () => {
    const frameworks = listPredictorFrameworks();

    it('discovers at least one predictor framework (guards against a vacuous suite)', () => {
        assert.ok(frameworks.length > 0, 'expected at least one predictors.d/<framework>/manifest.json');
    });

    describe('schema', () => {
        const ajv = new Ajv({ allErrors: true });
        const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

        for (const fw of frameworks) {
            it(`${fw}/manifest.json is schema-valid`, () => {
                const m = readPredictorManifest(fw);
                assert.ok(validate(m), `${fw} manifest invalid: ${JSON.stringify(validate.errors)}`);
            });
        }

        it('rejects a malformed manifest (missing required field)', () => {
            const broken = { framework: 'broken' }; // missing everything else
            assert.ok(!validate(broken), 'schema must reject a manifest missing required fields');
        });

        it('rejects an unknown top-level property', () => {
            const base = readPredictorManifest(frameworks[0]);
            const withExtra = { ...base, surprise: true };
            assert.ok(!validate(withExtra), 'schema must reject unknown top-level properties');
        });
    });

    describe('consumer agreement (the core drift guard)', () => {
        const vFormats = validatorModelFormats();

        for (const fw of frameworks) {
            it(`${fw}: validator formats == prompt formats == manifest model_formats`, () => {
                const manifestFmts = modelFormats(fw).slice().sort();
                const validatorFmts = (vFormats[fw] || []).slice().sort();
                const promptFmts = promptModelFormats(fw).slice().sort();

                assert.deepStrictEqual(
                    validatorFmts, manifestFmts,
                    `config-validator formats for "${fw}" must equal its manifest model_formats`
                );
                assert.deepStrictEqual(
                    promptFmts, manifestFmts,
                    `model-prompts formats for "${fw}" must equal its manifest model_formats`
                );
            });
        }

        it('the validator exposes exactly the discovered frameworks (no stale/missing engine)', () => {
            const stub = { deploymentConfigResolver: { getAllConfigs: () => [] } };
            const engines = new ConfigValidator(stub)._getSupportedOptions().engines.slice().sort();
            assert.deepStrictEqual(engines, frameworks.slice().sort());
        });
    });

    describe('descriptor integrity', () => {
        for (const fw of frameworks) {
            it(`${fw}: default_model_format is one of model_formats`, () => {
                const def = defaultModelFormat(fw);
                const fmts = modelFormats(fw);
                assert.ok(def, `${fw} must declare a default_model_format`);
                assert.ok(fmts.includes(def), `${fw} default "${def}" must be in [${fmts.join(', ')}]`);
            });

            it(`${fw}: ships a handler.py and non-empty pip_dependencies`, () => {
                assert.ok(handlerPath(fw), `${fw} must have a handler file on disk`);
                assert.ok(pipDependencies(fw).length > 0, `${fw} must declare pip_dependencies`);
            });
        }
    });

    describe('derived aggregate maps cover every framework', () => {
        it('modelFormatsMap / defaultModelFormatMap have an entry per framework', () => {
            const fm = modelFormatsMap();
            const dm = defaultModelFormatMap();
            for (const fw of frameworks) {
                assert.ok(Array.isArray(fm[fw]) && fm[fw].length > 0, `modelFormatsMap missing ${fw}`);
                assert.ok(dm[fw], `defaultModelFormatMap missing ${fw}`);
            }
        });

        it('formatToEngineMap round-trips every format back to a real framework', () => {
            const f2e = formatToEngineMap();
            for (const fw of frameworks) {
                for (const fmt of modelFormats(fw)) {
                    assert.ok(frameworks.includes(f2e[fmt]), `format "${fmt}" must map to a discovered framework`);
                }
            }
        });
    });
});

// Expose a tiny helper so unused-import lint does not flag existsSync if the
// handler check path changes; existsSync is used indirectly via handlerPath.
void existsSync;
