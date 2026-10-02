// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * loadCatalog — shared JSON catalog loader for bundled MCP servers.
 *
 * PATTERN: Shared utility. Replaces the byte-identical `loadCatalog` that was
 *   copy-pasted into 5 server index.js files with one implementation.
 * COLLABORATORS: used by servers/lib/create-picker-server.js and directly by
 *   servers that must load catalogs at module-init time (e.g. base-image-picker
 *   builds resolver singletons from catalog constants before the factory call).
 * DATA-FLOW ROLE: pure. Consumes a base directory + a path; produces parsed
 *   JSON. Throws (fatal) with the resolved path on a missing/invalid file.
 * See: docs/architecture/mcp-servers.md,
 *   docs/adr/ADR-003-mcp-picker-server-factory.md
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

/**
 * Resolve a server directory from either an `import.meta.url` (file: URL) or an
 * absolute directory path.
 * @param {string} serverDir - import.meta.url or an absolute dir path
 * @returns {string} absolute directory path
 */
export function resolveServerDir(serverDir) {
    return serverDir.startsWith('file:') ? dirname(fileURLToPath(serverDir)) : serverDir;
}

/**
 * Create a `loadCatalog(relativePath)` bound to a server directory. The returned
 * function resolves relative paths against `dir`; absolute paths pass through
 * unchanged (so callers can pass an absolute path too). Throws with the resolved
 * path on a missing file or invalid JSON.
 *
 * @param {string} dir - absolute server directory (from resolveServerDir)
 * @returns {(relativePath: string) => any}
 */
export function makeLoadCatalog(dir) {
    return function loadCatalog(relativePath) {
        const fullPath = resolve(dir, relativePath);
        let raw;
        try {
            raw = readFileSync(fullPath, 'utf8');
        } catch {
            throw new Error(`Catalog file not found: ${fullPath}`);
        }
        try {
            return JSON.parse(raw);
        } catch (err) {
            throw new Error(`Failed to parse catalog ${fullPath}: ${err.message}`);
        }
    };
}
