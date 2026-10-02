// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Engine Prefix Resolver
 *
 * PATTERN: Resolver over a single source of truth. Maps a model-server engine
 *   name to its env-var prefix by reading the engine's serve.d manifest
 *   (env_var_prefix), falling back to an explicit alias table only for engine
 *   aliases that have no serve.d directory of their own.
 * COLLABORATORS: reads via src/lib/serve-manifest-reader.js (readEnvVarPrefix →
 *   templates/code/serve.d/<engine>/manifest.json); imported by src/app.js
 *   (resolvePrefixedEnvVars) to prefix user --server-env values before render.
 * DATA-FLOW ROLE: consumes an engine name + a user-provided env key, produces
 *   the prefixed key. Prefix comes from the manifest (single source of truth);
 *   engines with no prefix (flask/fastapi/unknown) pass keys through unchanged.
 * See: docs/architecture/serve-engine-plugins.md,
 *   docs/adr/ADR-004-serve-engine-plugin-parity.md
 *
 * Requirements: 4.6
 */

import { readEnvVarPrefix } from './serve-manifest-reader.js';

/**
 * Explicit prefixes for engine ALIASES that do not have their own serve.d
 * plugin directory (and therefore no manifest to read). Real engines
 * (vllm, sglang, tensorrt-llm, lmi) get their prefix from their manifest's
 * env_var_prefix — the single source of truth — and must NOT be listed here.
 *
 * - vllm-omni: a vLLM variant with its own VLLM_OMNI_ prefix; no serve.d dir.
 * - djl: the raw DJL engine (no serve.d dir; it reuses the lmi wrapper). Its
 *   prefix is OPTION_ — the same vars the DJL Serving container actually reads
 *   (OPTION_TENSOR_PARALLEL_DEGREE, etc.), matching the lmi plugin. An earlier
 *   DJL_ alias never matched the container, so a user's --server-env values were
 *   silently ignored; corrected to OPTION_ (mirrors the lmi LMI_→OPTION_ fix).
 */
export const ENGINE_PREFIX_ALIASES = {
    'vllm-omni': 'VLLM_OMNI_',
    'djl': 'OPTION_'
};

/**
 * Resolve the env-var prefix for an engine.
 * Order: serve.d manifest env_var_prefix → alias table → '' (no prefix).
 *
 * @param {string} engine - The model server engine name (e.g. 'vllm', 'flask')
 * @param {string} [serveDir] - Optional serve.d root override (for tests)
 * @returns {string} The engine prefix (e.g. 'VLLM_'), or '' when the engine has
 *   no prefix (flask, fastapi, unknown).
 */
export function resolveEnginePrefix(engine, serveDir) {
    if (!engine) return '';
    const fromManifest = readEnvVarPrefix(engine, serveDir);
    if (fromManifest) return fromManifest;
    return ENGINE_PREFIX_ALIASES[engine] || '';
}

/**
 * Resolve the prefixed key for a given engine and user-provided key.
 * If the engine has a prefix (from its manifest or the alias table), prepends
 * it. If the engine has no prefix (flask, fastapi, or unknown), returns the key
 * unchanged.
 *
 * @param {string} engine - The model server engine name (e.g., 'vllm', 'flask')
 * @param {string} key - The user-provided environment variable key
 * @param {string} [serveDir] - Optional serve.d root override (for tests)
 * @returns {string} The resolved key with engine prefix applied (or unchanged)
 */
export function resolvePrefix(engine, key, serveDir) {
    const prefix = resolveEnginePrefix(engine, serveDir);
    return prefix ? `${prefix}${key}` : key;
}

/**
 * Resolve prefixed keys for a batch of server environment variables.
 * Returns a new object with all keys prefixed according to the engine prefix.
 *
 * @param {string} engine - The model server engine name
 * @param {Object<string, string>} serverEnvVars - Map of user-provided key-value pairs
 * @param {string} [serveDir] - Optional serve.d root override (for tests)
 * @returns {Object<string, string>} New object with prefixed keys and original values
 */
export function resolvePrefixedEnvVars(engine, serverEnvVars, serveDir) {
    const prefix = resolveEnginePrefix(engine, serveDir);
    const result = {};
    for (const [key, value] of Object.entries(serverEnvVars)) {
        result[prefix ? `${prefix}${key}` : key] = value;
    }
    return result;
}
