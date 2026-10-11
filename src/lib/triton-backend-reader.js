// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Triton Backend Reader (generation-time, Node side — BL119).
 *
 * Single source of truth for Triton per-backend knowledge, mirroring
 * `serve-manifest-reader.js`. Every consumer that used to re-encode a hardcoded
 * `backend === 'vllm' || backend === 'tensorrtllm'` name list, or a per-backend
 * model-format / GPU / sample-model list, SHALL derive from this reader instead
 * (ADR-008 "derive, don't hardcode").
 *
 * The source of truth is `servers/lib/catalogs/triton-backends.json`, validated
 * by `scripts/validate-servers.js` against `triton-backends.schema.json`. Each
 * backend declares:
 *   - requiresGpu          (boolean)
 *   - modelFormats         (string[] | null)
 *   - modelArtifactName    (string | null)
 *   - requiresModelName    (boolean)
 *   - supportsSampleModel  (boolean)
 *
 * and this reader adds one DERIVED predicate:
 *   - isLlm = requiresModelName === true && modelFormats === null
 *     (an LLM backend serves a HuggingFace model by name — vllm, tensorrtllm —
 *     rather than a file artifact). This replaces the hardcoded name list.
 *
 * Unknown-backend policy (Req 1.3): the lookup helpers FAIL LOUDLY for a backend
 * absent from the catalog rather than silently defaulting, so a typo or a missing
 * catalog entry surfaces at generation time instead of producing a quietly-wrong
 * project. (This mirrors the config.pbtxt unknown-backend fallback's intent — make
 * the unknown case explicit — at the generator layer.) Callers that legitimately
 * want a boolean for an arbitrary string use `isKnownBackend(backend)` first.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');
const TRITON_CATALOG = path.join(GENERATOR_ROOT, 'servers', 'lib', 'catalogs', 'triton-backends.json');

/**
 * Load + parse the Triton catalog. Throws if the catalog is missing or malformed
 * — the catalog is a committed, schema-validated file, so an unreadable catalog
 * is a build error, not a soft-fallback case.
 * @param {string} [catalogPath] - Optional override (tests).
 * @returns {Object<string, object>} The parsed catalog object.
 */
function loadCatalog(catalogPath = TRITON_CATALOG) {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    return JSON.parse(raw);
}

/**
 * The per-backend record, or throw if the backend is not in the catalog.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {object} The backend's catalog record.
 */
function backendMeta(backend, catalogPath = TRITON_CATALOG) {
    const catalog = loadCatalog(catalogPath);
    const meta = catalog[backend];
    if (!meta) {
        const known = Object.keys(catalog).sort().join(', ');
        throw new Error(
            `Unknown Triton backend '${backend}'. Known backends: ${known}. ` +
            'Add it to servers/lib/catalogs/triton-backends.json (and its schema) ' +
            'rather than hardcoding it in a consumer.'
        );
    }
    return meta;
}

/**
 * Sorted list of every backend declared in the catalog.
 * @param {string} [catalogPath]
 * @returns {string[]}
 */
export function listTritonBackends(catalogPath = TRITON_CATALOG) {
    return Object.keys(loadCatalog(catalogPath)).sort();
}

/**
 * True if the backend exists in the catalog. Use before the throwing helpers when
 * the input is an arbitrary/user string that may not be a Triton backend at all.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {boolean}
 */
export function isKnownBackend(backend, catalogPath = TRITON_CATALOG) {
    if (!backend) return false;
    return Object.prototype.hasOwnProperty.call(loadCatalog(catalogPath), backend);
}

/**
 * The backend's valid model formats (e.g. ['pkl', 'joblib', 'custom']), or null
 * for backends that serve a model by name rather than a file artifact (LLM backends).
 * Throws on an unknown backend (Req 1.3).
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {string[]|null}
 */
export function modelFormats(backend, catalogPath = TRITON_CATALOG) {
    return backendMeta(backend, catalogPath).modelFormats;
}

/**
 * The backend's sample-model artifact filename inside the model repository
 * (e.g. 'model.onnx'), or null when the backend has none. Throws on unknown.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {string|null}
 */
export function modelArtifactName(backend, catalogPath = TRITON_CATALOG) {
    return backendMeta(backend, catalogPath).modelArtifactName;
}

/**
 * True when the backend serves a HuggingFace model identified by name (so MLCC
 * must prompt for / forward a model name) rather than a file artifact. Throws on
 * unknown. For LLM backends this is true; for file-artifact backends, false.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {boolean}
 */
export function requiresModelName(backend, catalogPath = TRITON_CATALOG) {
    return backendMeta(backend, catalogPath).requiresModelName === true;
}

/**
 * True when the backend can ship the bundled sample (abalone) model. Throws on
 * unknown. NOTE: this is NOT the same as `isLlm` — pytorch is a non-LLM backend
 * that nonetheless declares supportsSampleModel:false — so the "offer the sample
 * model" decision MUST read this, not isLlm.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {boolean}
 */
export function supportsSampleModel(backend, catalogPath = TRITON_CATALOG) {
    return backendMeta(backend, catalogPath).supportsSampleModel === true;
}

/**
 * True when the backend requires a GPU instance type. Throws on unknown. This is
 * the catalog source for the (formerly hardcoded) GPU-requiring Triton backend set.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {boolean}
 */
export function requiresGpu(backend, catalogPath = TRITON_CATALOG) {
    return backendMeta(backend, catalogPath).requiresGpu === true;
}

/**
 * DERIVED predicate: true when the backend is an LLM backend — it serves a model
 * by name and has no file-artifact model formats. This replaces the hardcoded
 * `backend === 'vllm' || backend === 'tensorrtllm'` lists across the generator,
 * prompts, and templates. Throws on an unknown backend (Req 1.3).
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {boolean}
 */
export function isLlm(backend, catalogPath = TRITON_CATALOG) {
    const meta = backendMeta(backend, catalogPath);
    return meta.requiresModelName === true && meta.modelFormats === null;
}

/**
 * The sorted set of GPU-requiring backends, as plain backend names (e.g.
 * ['tensorrtllm', 'vllm']). Derived from the catalog `requiresGpu` flag — the
 * source for `template-manager.js`'s formerly-hardcoded `triton-*` GPU list.
 * @param {string} [catalogPath]
 * @returns {string[]}
 */
export function gpuRequiringBackends(catalogPath = TRITON_CATALOG) {
    const catalog = loadCatalog(catalogPath);
    return Object.keys(catalog)
        .filter(b => catalog[b].requiresGpu === true)
        .sort();
}

/**
 * The full Backend_Facts record for a backend (the five catalog fields plus the
 * derived `isLlm`). Convenience for consumers/tests that want everything at once.
 * Throws on an unknown backend.
 * @param {string} backend
 * @param {string} [catalogPath]
 * @returns {{requiresGpu: boolean, modelFormats: string[]|null, modelArtifactName: string|null, requiresModelName: boolean, supportsSampleModel: boolean, isLlm: boolean}}
 */
export function backendFacts(backend, catalogPath = TRITON_CATALOG) {
    const meta = backendMeta(backend, catalogPath);
    return {
        requiresGpu: meta.requiresGpu === true,
        modelFormats: meta.modelFormats,
        modelArtifactName: meta.modelArtifactName,
        requiresModelName: meta.requiresModelName === true,
        supportsSampleModel: meta.supportsSampleModel === true,
        isLlm: meta.requiresModelName === true && meta.modelFormats === null
    };
}
