// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Served-context resolution (BL240).
 *
 * The VRAM estimate budgets KV cache for the context the server will actually
 * SERVE, not the model's native maximum. A 4B model that publishes a 262144
 * max_position_embeddings is still deployed with the engine's default
 * max_model_len, so budgeting the native maximum pushed small models onto
 * oversized GPUs.
 *
 *   served context = explicit request (maxSequenceLength / profile override)
 *                  | min(model max_position_embeddings, engine default)
 *
 * The engine default is derived, not hardcoded per engine or per model:
 *   1. serve.d/<engine>/manifest.json gives the env var that carries the
 *      served context: env_var_prefix + dimension_map.max_model_len
 *      (vLLM: VLLM_ + MAX_MODEL_LEN, SGLang: SGLANG_ + CONTEXT_LENGTH, ...).
 *   2. servers/lib/catalogs/model-servers.json gives the value MLCC ships for
 *      that env var in the engine image's defaults.envVars (the newest, first,
 *      entry), i.e. what the generated container sets when the user does not.
 * When the engine is unknown or declares no default, the estimator's reference
 * length DEFAULT_MAX_SEQUENCE_LENGTH is used.
 *
 * Python mirror: templates/do/lib/python/instance_sizer.py
 * (resolve_served_context / engine_default_served_context). Drift guard:
 * test/unit/served-context-conformance.test.js.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_SEQUENCE_LENGTH } from './vram-estimator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** serve.d root in the MLCC source tree / npm package (templates/ ships with it). */
const SERVE_D = resolve(__dirname, '..', '..', '..', 'templates', 'code', 'serve.d');
/** Shared base-image catalog (engine image defaults). */
const MODEL_SERVERS_CATALOG = resolve(__dirname, '..', '..', 'lib', 'catalogs', 'model-servers.json');

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The env var that carries an engine's served context, from its manifest
 * (env_var_prefix + dimension_map.max_model_len), or null.
 *
 * @param {string} engine - serve.d engine name (e.g. 'vllm')
 * @param {string} [serveDir] - serve.d root override (tests)
 * @returns {string|null}
 */
function engineMaxModelLenEnvVar(engine, serveDir = SERVE_D) {
    if (!engine || typeof engine !== 'string') return null;
    const manifest = readJson(join(serveDir, engine, 'manifest.json'));
    const suffix = manifest?.dimension_map?.max_model_len;
    if (!suffix || typeof suffix !== 'string') return null;
    return `${manifest.env_var_prefix || ''}${suffix}`;
}

/**
 * The engine's default served context: the value the engine image's catalog
 * defaults set for its max_model_len env var.
 *
 * @param {string} engine
 * @param {object} [options]
 * @param {string} [options.serveDir] - serve.d root override (tests)
 * @param {string} [options.catalogPath] - model-servers.json override (tests)
 * @returns {{ value: number, envVar: string } | null}
 */
function engineDefaultServedContext(engine, options = {}) {
    const { serveDir = SERVE_D, catalogPath = MODEL_SERVERS_CATALOG } = options;
    const envVar = engineMaxModelLenEnvVar(engine, serveDir);
    if (!envVar) return null;
    const catalog = readJson(catalogPath);
    const entries = Array.isArray(catalog?.[engine]) ? catalog[engine] : [];
    const raw = entries[0]?.defaults?.envVars?.[envVar];
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? { value, envVar } : null;
}

/**
 * Resolve the context length the KV-cache estimate budgets for.
 *
 * @param {object} params
 * @param {number} [params.requested] - Explicit maxSequenceLength / profile override (wins as-is)
 * @param {number|null} [params.maxPositionEmbeddings] - Model's native maximum (null when unknown)
 * @param {string} [params.engine] - Serving engine (serve.d name)
 * @param {string} [params.serveDir] - serve.d root override (tests)
 * @param {string} [params.catalogPath] - model-servers.json override (tests)
 * @returns {{ servedContext: number, source: string, engineDefault: number }}
 */
function resolveServedContext(params = {}) {
    const { requested, maxPositionEmbeddings, engine, serveDir, catalogPath } = params;
    const engineDefaultInfo = engineDefaultServedContext(engine, { serveDir, catalogPath });
    const engineDefault = engineDefaultInfo ? engineDefaultInfo.value : DEFAULT_MAX_SEQUENCE_LENGTH;

    if (Number.isFinite(requested) && requested > 0) {
        return { servedContext: requested, source: 'requested', engineDefault };
    }

    const defaultSource = engineDefaultInfo
        ? `engine-default:${engine}:${engineDefaultInfo.envVar}`
        : 'sizer-default';
    if (Number.isFinite(maxPositionEmbeddings) && maxPositionEmbeddings > 0 && maxPositionEmbeddings < engineDefault) {
        return { servedContext: maxPositionEmbeddings, source: 'model-max-position-embeddings', engineDefault };
    }
    return { servedContext: engineDefault, source: defaultSource, engineDefault };
}

export {
    resolveServedContext,
    engineDefaultServedContext,
    engineMaxModelLenEnvVar,
    SERVE_D,
    MODEL_SERVERS_CATALOG
};
