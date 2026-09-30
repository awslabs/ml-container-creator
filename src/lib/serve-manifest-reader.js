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
