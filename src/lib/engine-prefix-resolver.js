// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Engine Prefix Resolver
 *
 * Maps model server names to their engine-specific environment variable
 * prefixes. When propagating --server-env values to the Dockerfile and
 * do/config templates, the resolver prepends the appropriate prefix so
 * users don't need to know internal prefix conventions.
 *
 * Requirements: 4.6
 */

/**
 * Engine-to-prefix mapping for server environment variables.
 * Engines not listed here (flask, fastapi) pass keys through unchanged.
 */
export const ENGINE_PREFIX_MAP = {
    'vllm': 'VLLM_',
    'vllm-omni': 'VLLM_OMNI_',
    'sglang': 'SGLANG_',
    'tensorrt-llm': 'TRTLLM_',
    'lmi': 'LMI_',
    'djl': 'DJL_'
};

/**
 * Resolve the prefixed key for a given engine and user-provided key.
 * If the engine has a defined prefix, prepends it to the key.
 * If the engine has no prefix (flask, fastapi, or unknown), returns the key unchanged.
 *
 * @param {string} engine - The model server engine name (e.g., 'vllm', 'flask')
 * @param {string} key - The user-provided environment variable key
 * @returns {string} The resolved key with engine prefix applied (or unchanged)
 */
export function resolvePrefix(engine, key) {
    const prefix = ENGINE_PREFIX_MAP[engine];
    if (prefix) {
        return `${prefix}${key}`;
    }
    return key;
}

/**
 * Resolve prefixed keys for a batch of server environment variables.
 * Returns a new object with all keys prefixed according to the engine mapping.
 *
 * @param {string} engine - The model server engine name
 * @param {Object<string, string>} serverEnvVars - Map of user-provided key-value pairs
 * @returns {Object<string, string>} New object with prefixed keys and original values
 */
export function resolvePrefixedEnvVars(engine, serverEnvVars) {
    const result = {};
    for (const [key, value] of Object.entries(serverEnvVars)) {
        const prefixedKey = resolvePrefix(engine, key);
        result[prefixedKey] = value;
    }
    return result;
}
