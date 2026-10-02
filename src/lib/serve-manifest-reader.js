// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serve-Layer Manifest Reader (generation-time, Node side of BL105).
 *
 * BL107: the SGLang (and vLLM) serve wrappers no longer hardcode their
 * environment-variable prefix. Instead the prefix is read from the engine's
 * serve-layer manifest (serve.d/<engine>/manifest.json, field `env_var_prefix`)
 * and injected into the EJS render context as `envVarPrefix`, so the generated
 * do/serve carries e.g. PREFIX="SGLANG_" exactly as before — but sourced from
 * the manifest rather than a literal in the template.
 *
 * This is the generation-time counterpart of do/lib/python/serve_manifest.py
 * (which the bash dispatchers use at deploy time). Both read the same manifest
 * files so the prefix has a single source of truth.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');
const SERVE_D = path.join(GENERATOR_ROOT, 'templates', 'code', 'serve.d');
const MODEL_SERVERS_CATALOG = path.join(GENERATOR_ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json');

/** Read + parse an engine's manifest, or null when missing/unreadable. */
function readManifest(engine, serveDir = SERVE_D) {
    if (!engine) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(serveDir, engine, 'manifest.json'), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Read the env_var_prefix for an engine from its serve-layer manifest.
 *
 * @param {string} engine - Engine name (e.g. 'vllm', 'sglang'). Matches the
 *   serve.d/<engine>/manifest.json directory name.
 * @param {string} [serveDir] - Optional override for the serve.d root (tests).
 * @returns {string} The manifest env_var_prefix (e.g. 'SGLANG_'), or '' when the
 *   engine has no manifest / no prefix (non-plugin engines like flask/fastapi).
 */
export function readEnvVarPrefix(engine, serveDir = SERVE_D) {
    if (!engine) return '';
    const manifestPath = path.join(serveDir, engine, 'manifest.json');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return typeof manifest.env_var_prefix === 'string' ? manifest.env_var_prefix : '';
    } catch {
        // No manifest (non-plugin engine) or unreadable — caller falls back.
        return '';
    }
}

/**
 * List the serve-engine plugin names that have a manifest, sorted.
 *
 * @param {string} [serveDir] - Optional override for the serve.d root (tests).
 * @returns {string[]} Engine directory names (e.g. ['lmi', 'sglang', 'tensorrt-llm', 'vllm']).
 */
export function listServeEngines(serveDir = SERVE_D) {
    let entries;
    try {
        entries = fs.readdirSync(serveDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isDirectory()
            && fs.existsSync(path.join(serveDir, e.name, 'manifest.json')))
        .map(e => e.name)
        .sort();
}

/**
 * Union of every serve engine's runtime-owned tunable vars (ADR-008 / BL105).
 *
 * Each engine's benchmark-tunable config vars are `env_var_prefix` + each
 * `dimension_map` value (e.g. vLLM's `tensor_parallel_degree → TENSOR_PARALLEL_SIZE`
 * becomes `VLLM_TENSOR_PARALLEL_SIZE`). These are written at runtime by
 * `do/benchmark --apply` / `do/deploy` and must survive `mcc regenerate`, so
 * `RUNTIME_OWNED_VARS` derives its engine slice from here instead of hardcoding
 * one engine's names. A generated project uses a single engine, so the union is a
 * harmless superset — a var not present in a project's do/config is simply never
 * captured.
 *
 * @param {string} [serveDir] - Optional override for the serve.d root (tests).
 * @returns {string[]} Sorted, de-duplicated full var names across all engines.
 */
export function serveEngineRuntimeVarsUnion(serveDir = SERVE_D) {
    const vars = new Set();
    for (const engine of listServeEngines(serveDir)) {
        let manifest;
        try {
            manifest = JSON.parse(
                fs.readFileSync(path.join(serveDir, engine, 'manifest.json'), 'utf8')
            );
        } catch {
            continue;
        }
        const prefix = typeof manifest.env_var_prefix === 'string' ? manifest.env_var_prefix : '';
        const dims = manifest.dimension_map;
        if (!prefix || typeof dims !== 'object' || dims === null) continue;
        for (const suffix of Object.values(dims)) {
            if (typeof suffix === 'string' && suffix) vars.add(`${prefix}${suffix}`);
        }
    }
    return [...vars].sort();
}

// ── Capability versioning (BL129) ──────────────────────────────────────────────
//
// Node/generation-time mirror of the version logic in
// templates/do/lib/python/serve_manifest.py. The flat manifest fields describe an
// engine's latest/default capabilities; `version_features` records the engine
// version at which each landed, and `min_version` the lowest version MLCC gates
// against. Consumers resolve the EFFECTIVE capability set for a detected engine
// version. FAIL-OPEN: an unknown/unparseable version applies no gating (returns
// the flat set), so version gating is an enhancement that never blocks a caller.

/**
 * Parse a dotted version into [major, minor, patch], or null. Tolerates a leading
 * 'v' and 1-3 numeric segments (missing default to 0); returns null for anything
 * non-numeric so callers can fail open.
 * @param {string} versionString
 * @returns {number[]|null}
 */
function parseSemver(versionString) {
    if (!versionString || typeof versionString !== 'string') return null;
    let s = versionString.trim();
    if (s.startsWith('v')) s = s.slice(1);
    const parts = s.split('.').slice(0, 3);
    const nums = [];
    for (const p of parts) {
        if (!/^\d+$/.test(p)) return null;
        nums.push(parseInt(p, 10));
    }
    if (nums.length === 0) return null;
    while (nums.length < 3) nums.push(0);
    return nums;
}

/** True if version a >= version b. Unparseable versions compare false. */
function semverGte(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return false;
    for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return true;
        if (pa[i] < pb[i]) return false;
    }
    return true;
}

/**
 * The supported_algorithms available at the given engine version: the flat list
 * minus any algorithm gated by a version_features entry whose `since` is above the
 * version. Fail-open: a null/unparseable version returns the full flat list.
 * @param {string} engine
 * @param {string|null} [version]
 * @param {string} [serveDir]
 * @returns {string[]}
 */
export function effectiveSupportedAlgorithms(engine, version = null, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    if (!manifest) return [];
    const flat = Array.isArray(manifest.supported_algorithms) ? [...manifest.supported_algorithms] : [];
    // Fail-open: unknown/unparseable version → no gating.
    if (parseSemver(version) === null) return flat;

    const gatedOut = new Set();
    for (const feature of manifest.version_features || []) {
        const since = feature && feature.since;
        if (!since) continue;
        // since > version  ⇔  NOT (version >= since)
        if (!semverGte(version, since)) {
            const adds = (feature.adds && feature.adds.supported_algorithms) || [];
            for (const alg of adds) gatedOut.add(alg);
        }
    }
    return flat.filter(a => !gatedOut.has(a));
}

/**
 * The engine's declared min_version, or null when it declares none.
 * @param {string} engine
 * @param {string} [serveDir]
 * @returns {string|null}
 */
export function minVersion(engine, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    return (manifest && manifest.min_version) || null;
}

/**
 * The engine's `engine_features` map — capabilities unique to this engine or
 * implemented differently from the others (ADR-004 §c), declared as data. Returns
 * {} when the engine declares none (vLLM/TensorRT-LLM/vLLM-Omni today).
 * @param {string} engine
 * @param {string} [serveDir]
 * @returns {Object<string, {env_var: string, type: string, values?: string[], default?: string, description: string}>}
 */
export function engineFeatures(engine, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    return (manifest && manifest.engine_features) || {};
}

/**
 * A single named engine feature's declaration, or null when the engine does not
 * declare it. Read generically — never branch on the engine name.
 * @param {string} engine
 * @param {string} feature - MLCC-stable feature key (e.g. 'radix_attention')
 * @param {string} [serveDir]
 * @returns {{env_var: string, type: string, values?: string[], default?: string, description: string}|null}
 */
export function engineFeature(engine, feature, serveDir = SERVE_D) {
    return engineFeatures(engine, serveDir)[feature] || null;
}

/**
 * Resolve user-requested engine features (MLCC feature name → value, as strings)
 * for the selected engine into concrete `{ key: env_var, value }` pairs, validating
 * each against the engine's `engine_features` declaration. Pure data: reads the
 * manifest, never branches on the engine name.
 *
 * Validation (derived from each feature's declaration):
 *   - unknown feature for this engine        → error (lists the engine's features)
 *   - type 'boolean' and value not true/false → error
 *   - type 'enum' and value not in `values`   → error (lists allowed values)
 *   - type 'int' and value not an integer     → error
 * On any error the pair is NOT emitted. Returns both the resolved pairs and the
 * collected error strings so the caller decides how to surface them.
 *
 * @param {string} engine
 * @param {Object<string,string>} requested - { featureName: value } (values are strings, as parsed from NAME=VALUE)
 * @param {string} [serveDir]
 * @returns {{ resolved: Array<{key: string, value: string}>, errors: string[] }}
 */
export function resolveEngineFeatureVars(engine, requested = {}, serveDir = SERVE_D) {
    const resolved = [];
    const errors = [];
    const features = engineFeatures(engine, serveDir);
    const available = Object.keys(features);

    for (const [name, rawValue] of Object.entries(requested || {})) {
        const decl = features[name];
        if (!decl) {
            const list = available.length ? available.join(', ') : '(none)';
            errors.push(
                `engine '${engine || 'unknown'}' has no feature '${name}'. ` +
                `Available engine features for this engine: ${list}.`
            );
            continue;
        }

        const value = String(rawValue);
        if (decl.type === 'boolean') {
            if (value !== 'true' && value !== 'false') {
                errors.push(`feature '${name}' is boolean — value must be 'true' or 'false', got '${value}'.`);
                continue;
            }
        } else if (decl.type === 'enum') {
            const allowed = Array.isArray(decl.values) ? decl.values : [];
            if (!allowed.includes(value)) {
                errors.push(`feature '${name}' must be one of: ${allowed.join(', ')} — got '${value}'.`);
                continue;
            }
        } else if (decl.type === 'int') {
            if (!/^-?\d+$/.test(value)) {
                errors.push(`feature '${name}' is an integer — got '${value}'.`);
                continue;
            }
        }
        // 'string' accepts any value.

        resolved.push({ key: decl.env_var, value });
    }

    return { resolved, errors };
}

/**
 * True if the detected version is at or above the engine's min_version. Fail-open:
 * true when the engine declares no min_version or the version is unparseable.
 * @param {string} engine
 * @param {string|null} version
 * @param {string} [serveDir]
 * @returns {boolean}
 */
export function isVersionSupported(engine, version, serveDir = SERVE_D) {
    const mv = minVersion(engine, serveDir);
    if (!mv) return true;
    if (parseSemver(version) === null) return true;
    return semverGte(version, mv);
}

/** Extract a semver-ish version from an image ref or tag, or null. */
function parseVersionFromTag(imageOrTag) {
    if (!imageOrTag || typeof imageOrTag !== 'string') return null;
    let tag = imageOrTag.includes(':') ? imageOrTag.slice(imageOrTag.lastIndexOf(':') + 1) : imageOrTag;
    if (tag.startsWith('v')) tag = tag.slice(1);
    const match = tag.match(/^(\d+(?:\.\d+){0,2})/);
    if (!match) return null;
    const parsed = parseSemver(match[1]);
    if (!parsed) return null;
    return `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
}

/**
 * Resolve the engine version for a deployment's BASE_IMAGE. Precedence:
 *   1. model-servers.json entry (under key `engine`) whose `image` or `tag`
 *      matches base_image → its `labels.framework_version`.
 *   2. Version parsed from the image tag (custom/override images).
 *   3. null (fail-open — the consumer applies no gating).
 * @param {string} engine
 * @param {string} baseImage
 * @param {string} [catalogPath] - override for the model-servers catalog (tests).
 * @returns {string|null}
 */
export function engineVersionFromBaseImage(engine, baseImage, catalogPath = MODEL_SERVERS_CATALOG) {
    if (!baseImage) return null;
    // 1. Catalog lookup by exact image or tag match.
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch {
        catalog = null;
    }
    if (catalog && typeof catalog === 'object') {
        const entries = Array.isArray(catalog[engine]) ? catalog[engine] : [];
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            if (entry.image === baseImage || entry.tag === baseImage) {
                const fw = entry.labels && entry.labels.framework_version;
                if (fw && parseSemver(fw) !== null) {
                    return parseVersionFromTag(fw) || fw;
                }
            }
        }
    }
    // 2. Tag-parse fallback.
    return parseVersionFromTag(baseImage);
}
