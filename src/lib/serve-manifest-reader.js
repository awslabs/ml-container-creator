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
 * Union of every serve engine's runtime-owned tunable vars (ADR-008 / BL105 /
 * ADR-010).
 *
 * Two per-engine sources, both `env_var_prefix` + a declared suffix:
 *   • `dimension_map` — benchmark-tunable config vars (e.g. vLLM's
 *     `tensor_parallel_degree → TENSOR_PARALLEL_SIZE` becomes
 *     `VLLM_TENSOR_PARALLEL_SIZE`), written by `do/benchmark --apply` / `do/deploy`.
 *   • `capability_map` — the Tier-1 engine-config suffixes (ADR-010): model, TP
 *     degree, and the LoRA toggle + companions (e.g. `VLLM_MAX_LORA_RANK`,
 *     `SGLANG_LORA_TARGET_MODULES`). A value a user reconfigures for one of these
 *     must likewise survive `mcc regenerate`, so it is derived here rather than
 *     hardcoded as a VLLM_ literal.
 *
 * `RUNTIME_OWNED_VARS` derives its engine slice from this union instead of
 * hardcoding one engine's names. A generated project uses a single engine, so the
 * union is a harmless superset — a var not present in a project's do/config is
 * simply never captured.
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
        if (!prefix) continue;
        const dims = manifest.dimension_map;
        if (dims && typeof dims === 'object') {
            for (const suffix of Object.values(dims)) {
                if (typeof suffix === 'string' && suffix) vars.add(`${prefix}${suffix}`);
            }
        }
        // ADR-010: Tier-1 capability env vars are runtime-owned too. Each
        // capability_map entry's `suffix` yields a full `<prefix><suffix>` var.
        const caps = manifest.capability_map;
        if (caps && typeof caps === 'object') {
            for (const decl of Object.values(caps)) {
                const suffix = decl && typeof decl.suffix === 'string' ? decl.suffix : '';
                if (suffix) vars.add(`${prefix}${suffix}`);
            }
        }
    }
    return [...vars].sort();
}

/**
 * The set of serve-engine environment-variable PREFIXES (e.g. `['SGLANG_',
 * 'VLLM_']`), DERIVED from every serve engine's manifest `env_var_prefix`.
 *
 * This is the single source the eks deploy's unbounded Tier-2 pass-through keys
 * on (`deploy.d/eks`: forward any `<prefix>*` engine var). `mcc regenerate` uses
 * it (BL158) to PRESERVE those same prefix-matched vars across a re-render, so a
 * user-set advanced engine knob is not silently dropped — deriving the prefixes
 * here rather than hardcoding `VLLM_`/`SGLANG_` keeps the two sides in agreement
 * and covers any new engine with a manifest prefix automatically (ADR-008).
 *
 * @param {string} [serveDir] - Optional serve.d root override (tests).
 * @returns {string[]} Sorted, de-duplicated engine prefixes (non-empty only).
 */
export function serveEnginePrefixes(serveDir = SERVE_D) {
    const prefixes = new Set();
    for (const engine of listServeEngines(serveDir)) {
        const prefix = readEnvVarPrefix(engine, serveDir);
        if (prefix) prefixes.add(prefix);
    }
    return [...prefixes].sort();
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
 * The engine's `metric_signals` map (Wave 9 R2.1): abstract signal name to
 * `{type, name}` or `{type: 'ratio', num, den}`. Returns {} when the engine
 * declares none. Node twin of serve_manifest.metric_signals(), used by the
 * serve-manifest signal conformance test.
 * @param {string} engine
 * @param {string} [serveDir]
 * @returns {Object<string, {type: string, name?: string, num?: string, den?: string}>}
 */
export function metricSignals(engine, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    return (manifest && manifest.metric_signals) || {};
}

/**
 * The engine's Tier-1 capability map (ADR-010), with each capability's env var
 * already prefixed. Tier 1 is the minimal set MLCC computes and injects (model,
 * tensor-parallel degree, LoRA + companions); everything else is Tier-2 prefix
 * pass-through and is NOT declared here. Returns {} when the engine declares none
 * (llama-cpp, vllm-omni) — an explicit "no injected config" statement.
 *
 * @param {string} engine
 * @param {string} [serveDir]
 * @returns {Object<string, {envVar: string, valueType: string, requires: string[]}>}
 */
export function capabilityMap(engine, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    if (!manifest) return {};
    const prefix = typeof manifest.env_var_prefix === 'string' ? manifest.env_var_prefix : '';
    const caps = manifest.capability_map;
    if (!prefix || typeof caps !== 'object' || caps === null) return {};
    const out = {};
    for (const [name, decl] of Object.entries(caps)) {
        if (!decl || typeof decl.suffix !== 'string' || !decl.suffix) continue;
        // Normalize the companion contract to OR-of-AND-groups (ADR-010):
        //   requires_any_of: [[...],[...]]  → used as-is (OR of AND-groups).
        //   requires: [...]                 → sugar for a single AND-group [[...]].
        //   neither                         → [[]] (one empty group = no companions).
        // The resolver emits the capability if ANY group fully resolves. `requires`
        // is kept for backward compatibility with existing consumers/tests.
        let requiresAnyOf;
        if (Array.isArray(decl.requires_any_of)) {
            requiresAnyOf = decl.requires_any_of.map((g) => (Array.isArray(g) ? [...g] : []));
        } else if (Array.isArray(decl.requires)) {
            requiresAnyOf = [[...decl.requires]];
        } else {
            requiresAnyOf = [[]];
        }
        out[name] = {
            envVar: `${prefix}${decl.suffix}`,
            valueType: decl.value_type === 'boolean' ? 'boolean' : 'valued',
            // Flat view: companions common to EVERY group (for callers/tests that
            // want "what is always required"). For a single-group contract this is
            // just that group; for multi-group it is the intersection.
            requires: requiresAnyOf.reduce(
                (acc, g, i) => (i === 0 ? [...g] : acc.filter((k) => g.includes(k))),
                []
            ),
            requiresAnyOf
        };
    }
    return out;
}

/**
 * Wave 6.1 (BL188): {capability: default} for every capability_map entry that
 * declares a `default`. This is the SINGLE source for MLCC's LoRA sizing defaults
 * (vLLM lora_max=4 / lora_max_rank=16); the generator resolver, prompt,
 * Dockerfile and parameter schema derive from it (drift-tested). Values keep the
 * manifest's JSON type. {} when the engine declares none.
 * @param {string} engine
 * @param {string} [serveDir]
 * @returns {Object<string,(string|number)>}
 */
export function capabilityDefaults(engine, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    const caps = manifest && manifest.capability_map;
    if (!caps || typeof caps !== 'object') return {};
    const out = {};
    for (const [name, decl] of Object.entries(caps)) {
        if (decl && Object.prototype.hasOwnProperty.call(decl, 'default') && decl.default !== null) {
            out[name] = decl.default;
        }
    }
    return out;
}

/**
 * The sorted discrete values an engine accepts for a capability (e.g. vLLM
 * lora_max_rank), or [] when it accepts any positive integer.
 * @param {string} engine
 * @param {string} capability
 * @param {string} [serveDir]
 * @returns {number[]}
 */
export function capabilityAllowed(engine, capability, serveDir = SERVE_D) {
    const manifest = readManifest(engine, serveDir);
    const decl = manifest && manifest.capability_map && manifest.capability_map[capability];
    if (!decl || !Array.isArray(decl.allowed)) return [];
    return decl.allowed.filter((v) => Number.isInteger(v) && v > 0).sort((a, b) => a - b);
}

/** The engine's default max LoRA rank (capability lora_max_rank.default), or null. */
export function loraRankDefault(engine, serveDir = SERVE_D) {
    const v = capabilityDefaults(engine, serveDir).lora_max_rank;
    return Number.isInteger(v) ? v : null;
}

/** The engine's allowed max LoRA rank values ([] = any positive integer). */
export function loraRankAllowed(engine, serveDir = SERVE_D) {
    return capabilityAllowed(engine, 'lora_max_rank', serveDir);
}

/** The engine's default max concurrent LoRA adapters (capability lora_max.default), or null. */
export function loraMaxDefault(engine, serveDir = SERVE_D) {
    const v = capabilityDefaults(engine, serveDir).lora_max;
    return Number.isInteger(v) ? v : null;
}

/**
 * Generation-time LoRA sizing defaults ({maxLoras, maxLoraRank}) for the
 * template resolver, the LoRA prompts and the Dockerfile ENV. Read from the
 * selected engine's manifest; an engine that declares no default for a field
 * (e.g. SGLang has no lora_max, LMI/llama-cpp have no capability_map) falls back
 * to the vLLM manifest — the engine whose VLLM_MAX_LORAS / VLLM_MAX_LORA_RANK the
 * Dockerfile emits. Never a literal (BL188 drift test).
 * @param {string} [engine]
 * @param {string} [serveDir]
 * @returns {{maxLoras: number|null, maxLoraRank: number|null}}
 */
export function loraSizingDefaults(engine, serveDir = SERVE_D) {
    const pick = (fn) => {
        const own = engine ? fn(engine, serveDir) : null;
        return own !== null ? own : fn('vllm', serveDir);
    };
    return { maxLoras: pick(loraMaxDefault), maxLoraRank: pick(loraRankDefault) };
}

/**
 * Resolve MLCC-computed Tier-1 capability VALUES for an engine into concrete
 * `{ key, value }` env-var pairs (ADR-010). This is the SINGLE home of the
 * companion-flag rule (Req 6): a capability is emitted only when it has a
 * resolvable value AND every capability in its `requires[]` also has a resolvable
 * value; otherwise it is omitted (never emitted bare) with a recorded skip reason.
 * Pure data — never branches on the engine name — so a custom plugin's companion
 * contract is honored identically.
 *
 * Value semantics:
 *   - A capability is "resolvable" when `values[name]` is present and non-empty.
 *     (For boolean capabilities, a truthy value — "true"/true — means enabled.)
 *   - value_type 'boolean': emit `KEY=true` only when enabled; emit nothing when
 *     absent/false/disabled.
 *   - value_type 'valued': emit `KEY=<value>`.
 *
 * @param {string} engine
 * @param {Object<string,(string|number|boolean)>} values - canonical capability → value
 * @param {string} [serveDir]
 * @returns {{ resolved: Array<{key: string, value: string}>, skipped: Array<{capability: string, reason: string}> }}
 */
export function resolveCapabilityVars(engine, values = {}, serveDir = SERVE_D) {
    const caps = capabilityMap(engine, serveDir);
    const resolved = [];
    const skipped = [];

    const isEnabled = (name) => {
        const v = values[name];
        if (v === undefined || v === null || v === '') return false;
        const decl = caps[name];
        if (decl && decl.valueType === 'boolean') {
            const s = String(v).toLowerCase();
            return s === 'true' || s === '1' || s === 'yes';
        }
        return true;
    };

    for (const [name, decl] of Object.entries(caps)) {
        if (!isEnabled(name)) continue; // nothing requested for this capability

        // Companion gating (OR of AND-groups): the capability is emittable if AT
        // LEAST ONE group has every companion resolvable. A single-group contract
        // (flat `requires`) is the common case; `[[]]` (no companions) always
        // passes. Engine-declared, never branches on the engine name.
        const groups = Array.isArray(decl.requiresAnyOf) ? decl.requiresAnyOf : [[]];
        const satisfied = groups.some((group) => group.every((req) => isEnabled(req)));
        if (!satisfied) {
            // Report the smallest unmet set — the group closest to being satisfied —
            // so the operator sees the most actionable "set these" hint.
            const bestGroup = groups
                .map((group) => group.filter((req) => !isEnabled(req)))
                .sort((a, b) => a.length - b.length)[0] || [];
            const joined = bestGroup.join(', ');
            const altNote = groups.length > 1 ? ' (or another supported companion group)' : '';
            skipped.push({
                capability: name,
                reason: `requires ${joined}${altNote} which ${bestGroup.length === 1 ? 'is' : 'are'} not set; omitting ${decl.envVar} rather than emitting it without its companion(s)`
            });
            continue;
        }

        if (decl.valueType === 'boolean') {
            resolved.push({ key: decl.envVar, value: 'true' });
        } else {
            resolved.push({ key: decl.envVar, value: String(values[name]) });
        }
    }

    return { resolved, skipped };
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
