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
