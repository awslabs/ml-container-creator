// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared EJS Fixture Loader
 *
 * Provides template loading and rendering utilities for property tests.
 * Templates are cached at module level (read-only after first load).
 * Safe for mocha --parallel since each worker gets its own module instance.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '../..');

// Module-level cache (read-only after first load, parallel-safe)
const _cache = new Map();

/**
 * Load a template file relative to project root. Cached after first call.
 * @param {string} relativePath - Path relative to project root
 * @returns {string} Template content
 */
export function loadTemplate(relativePath) {
    if (!_cache.has(relativePath)) {
        const fullPath = resolve(PROJECT_ROOT, relativePath);
        _cache.set(relativePath, readFileSync(fullPath, 'utf8'));
    }
    return _cache.get(relativePath);
}

/**
 * Render an EJS template with the given context.
 * @param {string} relativePath - Path relative to project root
 * @param {object} context - Template variables
 * @returns {string} Rendered output
 */
export function renderTemplate(relativePath, context) {
    const template = loadTemplate(relativePath);
    const fullPath = resolve(PROJECT_ROOT, relativePath);
    return ejs.render(template, context, { filename: fullPath });
}

/**
 * Shortcut: render templates/do/config with the given context.
 * @param {object} context - Template variables for do/config
 * @returns {string} Rendered output
 */
export function renderDoConfig(context) {
    return renderTemplate('templates/do/config', context);
}

/**
 * Shortcut: render the main Dockerfile template with the given context.
 * @param {object} context - Template variables for Dockerfile
 * @returns {string} Rendered output
 */
export function renderDockerfile(context) {
    return renderTemplate('templates/Dockerfile', context);
}
