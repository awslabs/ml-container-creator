// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Predictor-Framework Manifest Reader (generation-time, Node).
 *
 * The HTTP "predictor" frameworks (sklearn, xgboost, tensorflow) are a hybrid
 * plugin: each lives in templates/code/predictors.d/<framework>/ as a data
 * manifest.json (model_formats, default_model_format, pip_dependencies,
 * test_payload, base_image_catalog) next to a handler.py (the imperative
 * ModelHandler the manifest references). This reader is the single source of
 * truth that every consumer derives from — config-validator (accepted formats,
 * engines, default format), model-prompts (engine choices, format choices), and
 * src/app.js (pip deps, test payload, handler materialization) — replacing the
 * per-framework literals that were previously duplicated across those files.
 *
 * This is the predictor analogue of serve-manifest-reader.js. Unlike serve.d,
 * the descriptors are consumed ENTIRELY at generation time (the generated project
 * ships a concrete model_handler.py + requirements.txt), so there is deliberately
 * no deploy-time Python twin — see the predictor-framework-plugins design doc.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');
const PREDICTORS_D = path.join(GENERATOR_ROOT, 'templates', 'code', 'predictors.d');

/** Read + parse a framework's manifest, or null when missing/unreadable. */
function readManifest(framework, predictorsDir = PREDICTORS_D) {
    if (!framework) return null;
    try {
        return JSON.parse(
            fs.readFileSync(path.join(predictorsDir, framework, 'manifest.json'), 'utf8')
        );
    } catch {
        return null;
    }
}

/**
 * Public: read a framework's full manifest, or null.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {object|null}
 */
export function readPredictorManifest(framework, predictorsDir = PREDICTORS_D) {
    return readManifest(framework, predictorsDir);
}

/**
 * List the predictor-framework plugin names that have a manifest, sorted.
 * Dynamic discovery — scans predictors.d/ for subdirectories containing
 * manifest.json (so a new framework is picked up with no code edit), mirroring
 * listServeEngines(). The schema file (manifest.schema.json) is a plain file at
 * the root, not a directory, so it is naturally skipped.
 *
 * @param {string} [predictorsDir]
 * @returns {string[]} e.g. ['sklearn', 'tensorflow', 'xgboost']
 */
export function listPredictorFrameworks(predictorsDir = PREDICTORS_D) {
    let entries;
    try {
        entries = fs.readdirSync(predictorsDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isDirectory()
            && fs.existsSync(path.join(predictorsDir, e.name, 'manifest.json')))
        .map(e => e.name)
        .sort();
}

/**
 * The model file formats a framework can load (e.g. ['pkl', 'joblib']).
 * Soft read: returns [] for an unknown framework.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {string[]}
 */
export function modelFormats(framework, predictorsDir = PREDICTORS_D) {
    const m = readManifest(framework, predictorsDir);
    return (m && Array.isArray(m.model_formats)) ? m.model_formats : [];
}

/**
 * The default model format for a framework (used when none is supplied).
 * Soft read: returns null for an unknown framework.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {string|null}
 */
export function defaultModelFormat(framework, predictorsDir = PREDICTORS_D) {
    const m = readManifest(framework, predictorsDir);
    return (m && typeof m.default_model_format === 'string') ? m.default_model_format : null;
}

/**
 * The pinned pip requirement lines for a framework's requirements.txt section.
 * Soft read: returns [] for an unknown framework.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {string[]}
 */
export function pipDependencies(framework, predictorsDir = PREDICTORS_D) {
    const m = readManifest(framework, predictorsDir);
    return (m && Array.isArray(m.pip_dependencies)) ? m.pip_dependencies : [];
}

/**
 * The do/test sample /invocations payload for a framework (a JSON string).
 * Soft read: returns null for an unknown framework.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {string|null}
 */
export function testPayload(framework, predictorsDir = PREDICTORS_D) {
    const m = readManifest(framework, predictorsDir);
    return (m && typeof m.test_payload === 'string') ? m.test_payload : null;
}

/**
 * The human-readable label for a framework's interactive prompt (e.g.
 * 'scikit-learn'). Falls back to the framework name when absent.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {string}
 */
export function displayName(framework, predictorsDir = PREDICTORS_D) {
    const m = readManifest(framework, predictorsDir);
    return (m && typeof m.display_name === 'string') ? m.display_name : framework;
}

/**
 * The list of predictor engine names (sklearn, xgboost, tensorflow), discovered
 * dynamically — the single source of truth for config-validator's `engines`
 * list and the interactive engine prompt's set.
 * @param {string} [predictorsDir]
 * @returns {string[]}
 */
export function engines(predictorsDir = PREDICTORS_D) {
    return listPredictorFrameworks(predictorsDir);
}

/**
 * Map of framework → its model_formats (e.g. { sklearn: ['pkl','joblib'], ... }),
 * built from the descriptors. Replaces the per-framework literal duplicated in
 * config-validator.js and model-prompts.js.
 * @param {string} [predictorsDir]
 * @returns {Object<string,string[]>}
 */
export function modelFormatsMap(predictorsDir = PREDICTORS_D) {
    const map = {};
    for (const fw of listPredictorFrameworks(predictorsDir)) {
        map[fw] = modelFormats(fw, predictorsDir);
    }
    return map;
}

/**
 * Map of framework → its default_model_format (e.g. { sklearn: 'pkl', ... }).
 * Replaces the default-format literal in config-validator and config-manager.
 * @param {string} [predictorsDir]
 * @returns {Object<string,string>}
 */
export function defaultModelFormatMap(predictorsDir = PREDICTORS_D) {
    const map = {};
    for (const fw of listPredictorFrameworks(predictorsDir)) {
        const d = defaultModelFormat(fw, predictorsDir);
        if (d) map[fw] = d;
    }
    return map;
}

/**
 * Reverse map of model format → the framework that owns it (e.g.
 * { pkl: 'sklearn', joblib: 'sklearn', json: 'xgboost', ... }), built from the
 * descriptors. Replaces the `formatToEngine` literal in config-manager.js that
 * infers the engine from --model-format in --skip-prompts mode. When two
 * frameworks share a format the first discovered (alphabetical) wins; today the
 * three frameworks' format sets are disjoint so there is no collision.
 * @param {string} [predictorsDir]
 * @returns {Object<string,string>}
 */
export function formatToEngineMap(predictorsDir = PREDICTORS_D) {
    const map = {};
    for (const fw of listPredictorFrameworks(predictorsDir)) {
        for (const fmt of modelFormats(fw, predictorsDir)) {
            if (!(fmt in map)) map[fmt] = fw;
            // Also index a lowercased alias so callers that lowercase the format
            // (e.g. SavedModel → savedmodel) still resolve.
            const lower = fmt.toLowerCase();
            if (!(lower in map)) map[lower] = fw;
        }
    }
    return map;
}

/**
 * Absolute path to a framework's handler.py (the ModelHandler source rendered
 * into the generated project's code/model_handler.py). Returns null when the
 * framework or its declared handler file is missing.
 * @param {string} framework
 * @param {string} [predictorsDir]
 * @returns {string|null}
 */
export function handlerPath(framework, predictorsDir = PREDICTORS_D) {
    const m = readManifest(framework, predictorsDir);
    if (!m || typeof m.handler !== 'string') return null;
    const p = path.join(predictorsDir, framework, m.handler);
    return fs.existsSync(p) ? p : null;
}
