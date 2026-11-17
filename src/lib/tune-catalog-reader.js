// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Catalog Reader (BL144)
 *
 * Reads `config/tune-catalog.json` — the authoritative managed-customization catalog
 * maintained by `scripts/sync-model-families.js` — and exposes the managed-capable
 * models to the project-generation picker.
 *
 * This is the SAME catalog `do/tune` reads for its per-model technique guard, so the
 * picker, the capability badges, and the guard all answer from one source (Req 3).
 *
 * Pure, offline, dependency-free: no network, no AWS SDK. Never throws on a
 * missing/malformed catalog — returns `[]` so the caller falls back to the existing
 * `popular-transformers.json` path (Req 1.5).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default location of the tune catalog (same file `sync-model-families` writes). */
const CATALOG_PATH = path.resolve(__dirname, '..', '..', 'config', 'tune-catalog.json');

/**
 * @typedef {Object} ManagedModel
 * @property {string} hfId - the HuggingFace id (selectable model id in the picker)
 * @property {string} displayName
 * @property {string} family
 * @property {string} provider
 * @property {string[]} techniques - keys of the entry's Technique_Map (lowercased)
 */

/**
 * List the managed-capable models from the tune catalog, one entry per catalog model
 * that carries a `huggingFaceId` (the picker needs a selectable HF id — Req 1.2/1.3).
 *
 * Entries without a `huggingFaceId` are skipped for the picker (they remain valid for
 * `do/tune`, which keys by hub-content name). Duplicate `huggingFaceId`s are de-duped,
 * first-seen wins (defensive — shouldn't occur).
 *
 * @param {string} [catalogPath] - override the catalog path (for tests)
 * @returns {ManagedModel[]} managed models, or `[]` on missing/malformed catalog
 */
export function listManagedModels(catalogPath) {
    const filePath = catalogPath || CATALOG_PATH;

    let catalog;
    try {
        if (!existsSync(filePath)) return [];
        catalog = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        // Missing/malformed catalog — caller falls back to the serving list (Req 1.5).
        return [];
    }

    const models = catalog && typeof catalog === 'object' ? catalog.models : null;
    if (!models || typeof models !== 'object') return [];

    const out = [];
    const seen = new Set();

    for (const entry of Object.values(models)) {
        if (!entry || typeof entry !== 'object') continue;

        const hfId = entry.huggingFaceId;
        // Skip entries with no selectable HF id, or glob/pattern ids (defensive).
        if (!hfId || typeof hfId !== 'string' || hfId.includes('*')) continue;
        if (seen.has(hfId)) continue;
        seen.add(hfId);

        const techniques = entry.techniques && typeof entry.techniques === 'object'
            ? Object.keys(entry.techniques).map(t => String(t).toLowerCase())
            : [];

        out.push({
            hfId,
            displayName: entry.displayName || hfId,
            family: entry.family || '',
            provider: entry.provider || '',
            techniques
        });
    }

    return out;
}
