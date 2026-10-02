// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Triton backends catalog loader.
 *
 * PATTERN: Shared catalog reader (single source of truth). Replaces the
 *   byte-identical loadTritonBackendsFromCatalog + eager tritonBackends const
 *   that config-manager.js and config-validator.js each carried.
 * COLLABORATORS: imported by src/lib/config-manager.js and config-validator.js
 *   (they read tritonBackends[backend] to resolve Triton backend metadata);
 *   reads servers/lib/catalogs/triton-backends.json.
 * DATA-FLOW ROLE: consumes the catalog JSON, produces a backend-name to
 *   metadata map. Load failure degrades to {} with a warning (unchanged
 *   behavior), so a missing catalog never crashes config loading.
 * See: docs/architecture/command-handlers.md
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, '../../servers/lib/catalogs/triton-backends.json');

/**
 * Load and parse the Triton backends catalog. Returns {} (with a warning) on any
 * read/parse failure, matching the prior graceful-degradation behavior.
 * @returns {Object<string, object>} backend-name → metadata map
 */
export function loadTritonBackends() {
    try {
        return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    } catch (error) {
        console.warn(`Failed to load triton backends catalog: ${error.message}`);
        return {};
    }
}

/**
 * Eagerly-loaded catalog, matching how config-manager.js and config-validator.js
 * consumed it (a module-level const read at import time).
 */
export const tritonBackends = loadTritonBackends();
