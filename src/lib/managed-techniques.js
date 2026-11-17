// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Managed Techniques — the single source of truth for the managed-customization
 * technique enum (BL144).
 *
 * This module models TWO sets so that one derivation drives every consumer and nothing
 * drifts (derive-dont-hardcode / ADR-008):
 *
 *   - KNOWN      — every managed technique MLCC recognizes. These may appear in a tune
 *                  catalog entry's `techniques` map, get a capability badge + legend
 *                  entry, and are accepted by `do/tune` (`.tune_helper.py` `--technique`
 *                  choices are the same 5). `sync-model-families` keeps a recipe iff its
 *                  technique is KNOWN.
 *   - IMPLEMENTED — the subset MLCC can actually drive end-to-end today. `mtrl` is KNOWN
 *                  but NOT implemented (deferred — BL139: needs an MTRL-capable catalog
 *                  model + CustomAgentLambda authoring). A KNOWN-but-unimplemented
 *                  technique on a selected model triggers the post-generation warning
 *                  (Req 6) rather than a badge the user can act on.
 *
 * Consumers (all derive from here, none keep a parallel literal):
 *   - the model-picker capability badges + legend (D3)
 *   - the post-generation unimplemented-technique warning (D6)
 *   - `scripts/sync-model-families.js` recipe retention (`parseRecipes`)
 *
 * When a technique moves from KNOWN-but-unimplemented to implemented (e.g. MTRL lands),
 * add it to IMPLEMENTED_TECHNIQUES here and every consumer updates — the warning stops
 * firing for it, no other edit.
 */

/**
 * Every managed-customization technique MLCC recognizes, lowercase.
 * Kept in sync with `.tune_helper.py` `--technique` choices.
 * @type {readonly string[]}
 */
export const KNOWN_TECHNIQUES = Object.freeze(['sft', 'dpo', 'rlvr', 'rlaif', 'mtrl']);

/**
 * The subset of KNOWN_TECHNIQUES MLCC can drive end-to-end today.
 * `mtrl` is intentionally absent (known-but-unimplemented — BL139).
 * @type {readonly string[]}
 */
export const IMPLEMENTED_TECHNIQUES = Object.freeze(['sft', 'dpo', 'rlvr', 'rlaif']);

/**
 * Human-readable gloss per technique, for the picker legend. Keyed by the KNOWN id.
 * A KNOWN id missing here falls back to its uppercased id (never omitted).
 * @type {Readonly<Record<string, string>>}
 */
export const TECHNIQUE_LEGEND = Object.freeze({
    sft: 'supervised fine-tuning',
    dpo: 'preference (DPO)',
    rlvr: 'verifiable-reward RL',
    rlaif: 'LLM-judge RL',
    mtrl: 'multi-turn RL'
});

/**
 * True if `technique` is a technique MLCC recognizes (case-insensitive).
 * @param {string} technique
 * @returns {boolean}
 */
export function isKnownTechnique(technique) {
    return typeof technique === 'string'
        && KNOWN_TECHNIQUES.includes(technique.toLowerCase());
}

/**
 * True if `technique` is a technique MLCC can actually drive today (case-insensitive).
 * @param {string} technique
 * @returns {boolean}
 */
export function isImplementedTechnique(technique) {
    return typeof technique === 'string'
        && IMPLEMENTED_TECHNIQUES.includes(technique.toLowerCase());
}

/**
 * Derive the display abbreviation (badge) for a technique id. Uppercased id — NOT a
 * hand-maintained map — so a novel KNOWN technique is labeled without code changes.
 * @param {string} technique
 * @returns {string}
 */
export function techniqueBadge(technique) {
    return String(technique).toUpperCase();
}

/**
 * Partition a model's technique ids into the subset MLCC implements and the
 * known-but-unimplemented subset (the latter drives the Req 6 warning). Unknown ids are
 * ignored (they are not labeled or warned on). Case-insensitive; de-duplicated;
 * ordered by KNOWN_TECHNIQUES for stable output.
 * @param {string[]} techniques - technique ids from a model's Technique_Map
 * @returns {{ implemented: string[], unimplemented: string[] }}
 */
export function partitionTechniques(techniques) {
    const seen = new Set(
        (Array.isArray(techniques) ? techniques : [])
            .filter(t => typeof t === 'string')
            .map(t => t.toLowerCase())
    );
    const implemented = [];
    const unimplemented = [];
    for (const t of KNOWN_TECHNIQUES) {
        if (!seen.has(t)) continue;
        if (IMPLEMENTED_TECHNIQUES.includes(t)) implemented.push(t);
        else unimplemented.push(t);
    }
    return { implemented, unimplemented };
}

/**
 * Build the one-line legend string for the picker, derived from TECHNIQUE_LEGEND over
 * KNOWN_TECHNIQUES. A KNOWN id missing a gloss falls back to its uppercased id.
 * @returns {string} e.g. "SFT=supervised fine-tuning · DPO=preference (DPO) · ..."
 */
export function buildLegend() {
    return KNOWN_TECHNIQUES
        .map(t => `${techniqueBadge(t)}=${TECHNIQUE_LEGEND[t] || techniqueBadge(t)}`)
        .join(' · ');
}
