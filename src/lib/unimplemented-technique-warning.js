// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-generation unimplemented-technique warning (BL144, Req 6 / D6).
 *
 * If the selected model advertises a managed technique that MLCC recognizes but cannot
 * yet drive (today only `mtrl` — BL139), print a NON-BLOCKING note after generation so
 * the user's expectations are set. The model stays fully usable for the techniques MLCC
 * does support; this never alters the selected model id or exits non-zero.
 *
 * The implemented/known split is derived from the shared technique enum
 * (managed-techniques.js) and the technique data from the tune catalog — the SAME
 * sources the picker badges and `do/tune`'s guard use. When `mtrl` moves to implemented
 * (BL139), this warning stops firing for it automatically, no edit here.
 */

import { listManagedModels } from './tune-catalog-reader.js';
import {
    partitionTechniques,
    techniqueBadge,
    IMPLEMENTED_TECHNIQUES
} from './managed-techniques.js';

const CUSTOM_MODEL_SENTINEL = 'Custom (enter manually)';

/**
 * Resolve the effective model id from generation answers. Free-entry puts the sentinel
 * in `modelName` and the real id in `customModelName`.
 * @param {object} answers
 * @returns {string} the model id, or '' when none
 */
function resolveModelId(answers) {
    const name = answers && answers.modelName;
    if (!name || name === CUSTOM_MODEL_SENTINEL) {
        return (answers && answers.customModelName) || '';
    }
    return name;
}

/**
 * Compute the known-but-unimplemented techniques advertised by the selected model.
 * Returns `[]` when the model is not a managed-capable catalog model, has no
 * unimplemented techniques, or the catalog is unavailable.
 *
 * @param {object} answers - generation answers (needs `modelName`/`customModelName`)
 * @param {string} [catalogPath] - override tune-catalog path (for tests)
 * @returns {string[]} unimplemented technique ids (KNOWN but not IMPLEMENTED)
 */
export function unimplementedTechniquesFor(answers, catalogPath) {
    const modelId = resolveModelId(answers);
    if (!modelId) return [];

    const managed = listManagedModels(catalogPath);
    const entry = managed.find(m => m.hfId === modelId);
    if (!entry) return []; // serving-only / free-entry / non-catalog → nothing to warn

    return partitionTechniques(entry.techniques).unimplemented;
}

/**
 * Print the non-blocking warning if the selected model advertises any
 * known-but-unimplemented technique. Safe to call unconditionally after generation.
 *
 * @param {object} answers - generation answers
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] - sink (default console.log; for tests)
 * @param {string} [opts.catalogPath] - override tune-catalog path (for tests)
 * @returns {boolean} true if a warning was printed
 */
export function warnUnimplementedTechniques(answers, opts = {}) {
    const log = opts.log || ((msg) => console.log(msg));
    const unimplemented = unimplementedTechniquesFor(answers, opts.catalogPath);
    if (unimplemented.length === 0) return false;

    const modelId = resolveModelId(answers);
    const unBadges = unimplemented.map(techniqueBadge).join(', ');
    const okBadges = IMPLEMENTED_TECHNIQUES.map(techniqueBadge).join('/');

    log('');
    log(`⚠️  ${modelId} advertises managed ${unBadges}, which MLCC does not yet drive.`);
    log(`   The model is still usable for the techniques MLCC supports (${okBadges}),`);
    log('   and for self-managed customization via do/train.');
    return true;
}
